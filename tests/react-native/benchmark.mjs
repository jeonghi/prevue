import { execFileSync } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { center, fixture, projects, treeNodes } from './projects.mjs';

const repeats=Number(process.argv[2] ?? 10);
if (!Number.isInteger(repeats) || repeats<1) throw Error('Supply a positive repetition count');
const millis=async fn=>{const start=performance.now();const value=await fn();return {ms:Math.round(performance.now()-start),value};};
function stats(samples) {
  const ordered=[...samples].sort((a,b)=>a-b);
  const q=p=>ordered[Math.ceil(p*ordered.length)-1];
  return {n:samples.length,p50:q(.5),p95:q(.95),samples};
}
async function rss(home) {
  const pids=new Set();
  for(const id of await readdir(path.join(home,'rn'))) {
    const file=path.join(home,'rn',id,'web','instance.json');
    const record=await readFile(file,'utf8').then(JSON.parse,()=>null);if(record) pids.add(record.pid);
  }
  const rows=execFileSync('ps',['-axo','pid=,ppid=,rss='],{encoding:'utf8'}).trim().split('\n').map(row=>row.trim().split(/\s+/).map(Number));
  let added=true;
  while(added) {added=false;for(const [id,parent] of rows) if(pids.has(parent)&&!pids.has(id)){pids.add(id);added=true;}}
  return Math.round(rows.reduce((total,[id,,kb])=>total+(pids.has(id)?kb:0),0)/1024);
}
const suite=await projects(3);
try {
  const [a,b,c]=suite.roots;
  const cli=(...args)=>suite.cli(a,args);
  const first=await millis(()=>cli('show','OrderCard.preview.tsx'));
  const before=await rss(suite.home);
  const focused=await cli('focus','0','--on');
  const button=(await treeNodes(focused)).find(n=>n.testId==='order-detail');
  if(!button) throw Error('Missing order detail button');
  const warm=[],interact=[],save=[];
  for(let i=0;i<repeats;i++) {
    warm.push((await millis(()=>cli('render'))).ms);
    const current=(await treeNodes(await cli('render'))).find(n=>n.testId==='order-detail');
    interact.push((await millis(()=>cli('touch',...center(current)))).ms);
  }
  await cli('focus','0','--off');
  const file=path.join(a,'OrderCard.tsx'), source=await readFile(file,'utf8');
  let gen=(await cli('status')).generation;
  for(let i=0;i<repeats;i++) {
    const update=await millis(async()=>{
      await writeFile(file,source.replace('padding: 22','padding: '+(i%2?22:30)));
      return cli('wait','OrderCard.tsx','--after',String(gen),'--timeout','30');
    });
    gen=update.value.generation;save.push(update.ms);
  }
  await Promise.all([b,c].map(root=>suite.cli(root,['show','OrderCard.preview.tsx'])));
  const memory3=await rss(suite.home);
  const pkg=JSON.parse(await readFile(path.join(fixture,'package.json'),'utf8'));
  const result={
    hardware:os.cpus()[0].model,logicalCpus:os.cpus().length,ramGiB:Math.round(os.totalmem()/2**30),
    os:os.version(),node:process.version,platform:'web',fixture:'OrderCard.preview.tsx (three cards, focus Default)',
    react:pkg.dependencies.react,reactNative:pkg.dependencies['react-native'],reactNativeWeb:pkg.dependencies['react-native-web'],
    coldDaemonMs:first.value.timings.launchMs,firstBoardRequestMs:first.value.timings.boardMs,coldShowCliMs:first.ms,
    firstCardRendererMs:first.value.cards[0].durationMs,warmFocusedCliMs:stats(warm),saveToBoardCliMs:stats(save),tapToScreenshotCliMs:stats(interact),
    rssOneProjectMiB:before,rssThreeProjectsMiB:memory3,
  };
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
} finally {await suite.close();}
