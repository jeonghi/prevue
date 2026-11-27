import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, readFile, realpath, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite, loadInstance, location, portCandidate, type Instance } from './instance.ts';
import { errorInfo, PreviewFailure } from './errors.ts';
import { ProjectSession } from './session.ts';
import type { Platform, PreviewRenderer, ViewerHost, ViewerRoute } from './protocol.ts';

const viewerDir = fileURLToPath(new URL('../../viewer/',import.meta.url));
const mime: Record<string,string> = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8',
  '.svg':'image/svg+xml','.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.woff2':'font/woff2'};
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}).end(JSON.stringify(value));
}
function equalToken(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x,y);
}
async function body(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) throw new PreviewFailure('USAGE','Request body too large',2);
    chunks.push(chunk);
  }
  try {
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString());
    if (data && typeof data === 'object' && !Array.isArray(data)) return data as Record<string,unknown>;
  } catch { /* reject malformed JSON below */ }
  throw new PreviewFailure('USAGE','Expected a JSON object',2);
}
async function rendererFor(platform: Platform, root: string): Promise<PreviewRenderer> {
  const pkg = JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
  const expo = !!(pkg.dependencies?.expo || pkg.devDependencies?.expo);
  const adapter = platform !== 'web' ? 'native' : expo ? 'expo' : 'web';
  const entry = new URL('./'+adapter+'/index.ts',import.meta.url);
  if (!await stat(fileURLToPath(entry)).then(s=>s.isFile(),()=>false)) {
    throw new PreviewFailure('ADAPTER_UNAVAILABLE','The '+adapter+' adapter is unavailable in this checkout',3);
  }
  const imported = await import(entry.href);
  return adapter === 'native' ? imported.createNativeRenderer() : adapter === 'expo' ? imported.createExpoRenderer() : imported.createWebRenderer();
}
async function start() {
  const [root, name, device] = process.argv.slice(2);
  if (!root || !['web','ios','android'].includes(name)) throw new PreviewFailure('USAGE','Internal launch arguments invalid',2);
  const platform = name as Platform;
  const loc = location(root,platform);
  await mkdir(loc.dir,{recursive:true,mode:0o700});
  const token = randomBytes(32).toString('hex');
  const cookie = 'prevue_rn_' + loc.key;
  const artifacts = path.join(loc.dir, 'captures', randomBytes(8).toString('hex'));
  await mkdir(artifacts,{recursive:true,mode:0o700});
  const artRoot = await realpath(artifacts);
  let session: ProjectSession | undefined, handleViewer: ViewerRoute | undefined, record: Instance | undefined;
  const routes = new Map<string,string>();
  const host: ViewerHost = {
    snapshot:()=>session!.state, subscribe:fn=>session!.subscribe(fn), execute:(cmd,args)=>session!.execute(cmd,args),
    artifactUrl(file) {
      if (!path.resolve(file).startsWith(artRoot+path.sep)) throw new PreviewFailure('ARTIFACT_UNAVAILABLE','Invalid capture path');
      const id = createHash('sha256').update(file).digest('hex') + path.extname(file);
      routes.set(id, file);
      return '/artifacts/' + id;
    },
  };
  let shutting = false;
  async function stop() {
    if (shutting) return;
    shutting = true;
    server.close();
    server.closeAllConnections();
    try { await session?.dispose(); }
    finally {
      if ((await loadInstance(loc.record))?.token === token) await unlink(loc.record).catch(()=>{});
      process.exit(0);
    }
  }
  async function route(req: IncomingMessage, res: ServerResponse) {
    const address = server.address();
    if (!address || typeof address === 'string') return json(res,503,{ok:false});
    const hostname = '127.0.0.1:' + address.port;
    const origin = 'http://' + hostname;
    res.setHeader('referrer-policy','no-referrer');
    res.setHeader('x-content-type-options','nosniff');
    res.setHeader('x-frame-options','DENY');
    if (req.headers.host !== hostname || req.headers.origin && req.headers.origin !== origin) return json(res,403,{ok:false,error:'Untrusted origin'});
    const url = new URL(req.url ?? '/',origin);
    if (url.pathname === '/identity' && req.method === 'GET') return json(res,200,{key:loc.key});
    if (url.pathname === '/' && req.method === 'GET' && equalToken(url.searchParams.get('session') ?? '',token)) {
      const lang = url.searchParams.get('lang');
      res.writeHead(303,{'set-cookie':cookie+'='+token+'; HttpOnly; SameSite=Strict; Path=/',location:lang?'/?lang='+encodeURIComponent(lang):'/','cache-control':'no-store'}).end();
      return;
    }
    const authorization = req.headers.authorization;
    const bearer = typeof authorization === 'string' && equalToken(authorization,'Bearer '+token);
    const loggedIn = req.headers.cookie?.split(';').some(value => equalToken(value.trim(),cookie+'='+token));
    if (!bearer && !loggedIn) return json(res,401,{ok:false,error:'Open the viewer URL returned by prevue rn open'});
    if (url.pathname === '/health') return json(res,session && record ? 200:503,{key:loc.key});
    if (!session || !record) return json(res,503,{ok:false,error:'Starting preview runtime'});
    if (url.pathname.startsWith('/command/') && req.method === 'POST') {
      if (!bearer) return json(res,403,{ok:false,error:'CLI credentials required'});
      const cmd = url.pathname.slice(9);
      if (cmd === 'stop') { res.once('finish',()=>void stop()); return json(res,200,{ok:true}); }
      return json(res,200,await session.execute(cmd,await body(req)));
    }
    if (handleViewer && await handleViewer(req,res,url,host)) return;
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res,405,{ok:false,error:'Unsupported method'});
    let file: string;
    if (url.pathname.startsWith('/artifacts/')) {
      const target = routes.get(url.pathname.slice(11));
      if (!target) return json(res,404,{ok:false});
      file = await realpath(target);
      if (!file.startsWith(artRoot+path.sep)) return json(res,403,{ok:false});
    } else {
      const rel = decodeURIComponent(url.pathname.slice(1)) || 'index.html';
      file = await realpath(path.resolve(viewerDir,rel)).catch(()=>'');
      if (!file || !file.startsWith(path.resolve(viewerDir)+path.sep)) return json(res,404,{ok:false});
    }
    if (!(await stat(file)).isFile()) return json(res,404,{ok:false});
    res.setHeader('content-type',mime[path.extname(file)] ?? 'application/octet-stream');
    res.setHeader('cache-control',url.pathname.startsWith('/artifacts/')?'private, max-age=31536000, immutable':'no-cache');
    res.end(req.method === 'HEAD' ? undefined : await readFile(file));
  }
  const server = createServer((req,res)=>{void route(req,res).catch(err=>{
    if (res.headersSent) { res.destroy(); return; }
    const exitCode = err instanceof PreviewFailure ? err.exitCode : 1;
    json(res,exitCode === 2 ? 400 : 422,{ok:false,error:errorInfo(err),exitCode});
  });});
  for (let i = 0; i < 32; i++) {
    const port = portCandidate(loc.key,i);
    try {
      await new Promise<void>((resolve,reject)=>{
        const fail = (err:Error)=>{server.off('listening',on);reject(err);};
        const on = ()=>{server.off('error',fail);resolve();};
        server.once('error',fail).once('listening',on).listen(port,'127.0.0.1');
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
      const peer = await fetch('http://127.0.0.1:'+port+'/identity',{signal:AbortSignal.timeout(600)}).then(r=>r.json()).catch(()=>null);
      if (peer?.key === loc.key) { process.send?.({existing:true}); process.disconnect?.(); return; }
      continue;
    }
    const renderer = await rendererFor(platform,root);
    session = new ProjectSession(root,platform,renderer);
    process.once('SIGTERM',()=>void stop()); process.once('SIGINT',()=>void stop());
    const viewerEntry = new URL('./viewer/index.ts',import.meta.url);
    if (await stat(fileURLToPath(viewerEntry)).then(s=>s.isFile(),()=>false)) handleViewer = (await import(viewerEntry.href)).handleViewer;
    await session.init(artRoot,device);
    record = {root,platform,device,key:loc.key,pid:process.pid,token,url:'http://127.0.0.1:'+port};
    await atomicWrite(loc.record, JSON.stringify(record));
    process.send?.({ready:true});
    if (process.connected) process.disconnect();
    return;
  }
  throw new PreviewFailure('PORT_UNAVAILABLE','No free local preview port',3);
}
start().catch(err=>{
  console.error(err);
  if (process.connected) process.send?.({error:errorInfo(err)},()=>process.exit(1));
  else process.exit(1);
});
