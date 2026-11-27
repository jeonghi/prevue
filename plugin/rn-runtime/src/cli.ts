import { fork, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, open, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { parse } from './commands.ts';
import { atomicWrite, isAlive, loadInstance, location, type Instance } from './instance.ts';
import { errorInfo, PreviewFailure } from './errors.ts';
import { discover, findProject } from './registry.ts';
import type { Platform } from './protocol.ts';

async function launch(root:string, platform:Platform, device?:string):Promise<Instance> {
  const loc=location(root,platform);
  const log=await open(loc.log,'a',0o600);
  const execArgv = [...process.execArgv];
  // Node 22.12 and early 23.x releases expose node:sqlite behind this flag.
  if (process.allowedNodeEnvironmentFlags.has('--experimental-sqlite')) execArgv.push('--experimental-sqlite');
  let child;
  try {
    child = fork(fileURLToPath(new URL('./daemon.ts', import.meta.url)), [root, platform, ...(device ? [device] : [])],
      { detached: true, stdio: ['ignore', log.fd, log.fd, 'ipc'], execArgv });
    const daemon = child;
    return await new Promise<Instance>((resolve, reject) => {
      const timer = setTimeout(() => {
        daemon.kill('SIGTERM');
        reject(new PreviewFailure('TIMEOUT', 'Runtime startup timed out. Read prevue rn log', 3));
      }, 180000);
      daemon.once('message', (message: { record?: Instance; error?: { code: string; message: string } }) => {
        clearTimeout(timer);
        if (message.error) return reject(new PreviewFailure(message.error.code, message.error.message, 3));
        if (message.record?.key === loc.key) return resolve(message.record);
        reject(new PreviewFailure('RUNTIME_UNAVAILABLE', 'Runtime returned an invalid startup response', 3));
      });
      daemon.once('error', error => { clearTimeout(timer); reject(error); });
      daemon.once('exit', code => {
        clearTimeout(timer);
        reject(new PreviewFailure('RUNTIME_UNAVAILABLE', 'Runtime exited (' + code + '). Read prevue rn log', 3));
      });
    });
  } finally {
    if (child?.connected) child.disconnect();
    child?.unref();
    await log.close();
  }
}

async function main() {
  const parsed=parse(process.argv.slice(2));
  if ('help' in parsed) {console.log(parsed.help);return;}
  const {cmd,args,device}=parsed;
  const target=parsed.project ?? (typeof args.file==='string'?args.file:'.');
  let root:string;
  try {root=await findProject(path.resolve(target));}
  catch(err){throw new PreviewFailure('PROJECT_NOT_FOUND',errorInfo(err).message,3);}
  if(typeof args.file==='string') {
    args.file=path.resolve(parsed.project ? root : process.cwd(),args.file);
  }
  const base=location(root,'web');
  const last=await readFile(base.active,'utf8').catch(()=>'web');
  const platform=parsed.platform ?? (cmd==='show' ? 'web' : last==='ios'||last==='android'?last:'web');
  const loc=location(root,platform);
  if (cmd==='previews') {
    const all=await discover(root);
    const rel=args.file?path.relative(root,String(args.file)):undefined;
    console.log(JSON.stringify({ok:true,previews:rel?all.filter(p=>p.source.file===rel):all}));return;
  }
  if (cmd==='doctor') {
    const req=createRequire(path.join(root,'package.json'));
    const manifest=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
    const expo=!!(manifest.dependencies?.expo||manifest.devDependencies?.expo);
    const adapter=platform==='web' ? expo?'expo':'web' : 'native';
    const missing=platform==='web' ? ['react','react-dom','react-native-web'].filter(name=>{try{req.resolve(name);return false;}catch{return true;}}) : [];
    const adapterPresent=await stat(fileURLToPath(new URL('./'+adapter+'/index.ts',import.meta.url))).then(s=>s.isFile(),()=>false);
    const out={ok:!missing.length&&adapterPresent,root,platform,adapter,adapterPresent,missing,daemon:await isAlive(await loadInstance(loc.record),loc.key),node:process.version};
    console.log(JSON.stringify(out)); if(!out.ok) process.exitCode=3;return;
  }
  if(cmd==='log') {
    const contents=await readFile(loc.log,'utf8').catch(()=>{throw new PreviewFailure('RUNTIME_UNAVAILABLE','No log for this project/platform',3);});
    console.log(JSON.stringify({ok:true,log:contents.trimEnd().split('\n').slice(-Number(args.lines))}));return;
  }
  let launchMs: number | undefined;
  let record=await loadInstance(loc.record);
  if(!record || !await isAlive(record,loc.key)) {
    if(cmd!=='show') throw new PreviewFailure('RUNTIME_UNAVAILABLE','Run prevue rn show <file> for this project and platform',3);
    await mkdir(loc.dir,{recursive:true,mode:0o700});
    const started=performance.now();
    record=await launch(root,platform,device);
    launchMs=Math.round(performance.now()-started);
  }
  if(device && device!==record.device) throw new PreviewFailure('DEVICE_IN_USE','This project already has a session on another device',3);
  const viewer=record.url+'/?'+new URLSearchParams({session:record.token,...(parsed.lang?{lang:parsed.lang}:{})});
  if(cmd==='open'){
    let opened=false;
    if(!parsed.noOpen) {
      const action=process.platform==='darwin'?'open':'xdg-open';
      opened=await new Promise<boolean>(resolve=>{
        const child=spawn(action,[viewer],{stdio:'ignore'});child.once('error',()=>resolve(false));child.once('exit',code=>resolve(code===0));
      });
    }
    console.log(JSON.stringify({ok:true,opened,viewer}));return;
  }
  const requested=performance.now();
  const response=await fetch(record.url+'/command/'+cmd,{method:'POST',headers:{authorization:'Bearer '+record.token,'content-type':'application/json'},
    signal:AbortSignal.timeout(180000),body:JSON.stringify(args)});
  const data=await response.json();
  if(cmd==='show' && response.ok) {
    data.timings={launchMs:launchMs ?? null,boardMs:Math.round(performance.now()-requested)};
    await atomicWrite(loc.active,platform);
  }
  if(['show','board','status','focus','wait','render'].includes(cmd)) data.viewer=viewer;
  console.log(JSON.stringify(data));
  if(!response.ok || data.ok===false) process.exitCode=data.exitCode ?? 1;
}
main().catch(err=>{
  const exitCode=err instanceof PreviewFailure ? err.exitCode : 1;
  console.log(JSON.stringify({ok:false,error:errorInfo(err),exitCode}));process.exitCode=exitCode;
});
