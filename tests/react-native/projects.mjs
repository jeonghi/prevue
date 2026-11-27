import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const run = promisify(execFile);
export const repo = fileURLToPath(new URL('../../',import.meta.url));
export const fixture = path.join(repo,'fixtures/react-native-web');
export const runtimeRequire = createRequire(path.join(repo,'plugin/rn-runtime/package.json'));
export const {chromium} = runtimeRequire('playwright');
export async function projects(count) {
  const temp = await mkdtemp(path.join(tmpdir(),'prevue-e2e-'));
  const first = path.join(temp,'react-native-web');
  await cp(fixture,first,{recursive:true,filter:f=>!['node_modules','.git','.prevue'].includes(path.basename(f))});
  const git = (...args)=>run('git',['-C',first,...args]);
  await writeFile(path.join(first,'.gitignore'),'node_modules/\n');
  await git('init','-q'); await git('add','.');
  await git('-c','user.name=Prevue fixture','-c','user.email=fixture@localhost','-c','commit.gpgsign=false','commit','-qm','fixture');
  const roots=[first];
  for(let i=1;i<count;i++) {
    const next=path.join(temp,String.fromCharCode(97+i));
    await git('worktree','add','--quiet','--detach',next,'HEAD'); roots.push(next);
  }
  const env={...process.env,PREVUE_HOME:path.join(temp,'state')};
  for(const root of roots) await symlink(path.join(fixture,'node_modules'),path.join(root,'node_modules'),'dir');
  async function cli(root,args,code=0) {
    let output;
    try {
      const result=await run(path.join(repo,'plugin/bin/prevue'),['rn',...args],{cwd:root,env,maxBuffer:8*1024*1024,timeout:185000});
      output=result.stdout;
      assert.equal(code,0,'command '+args[0]+' unexpectedly succeeded');
    } catch(err) {
      if(!('stdout' in err)) throw err;
      if(err.code!==code) throw Error('Command '+args[0]+' exited '+err.code+': '+(err.stdout||err.stderr).replace(/session=[a-f0-9]+/g,'session=<private>'));
      output=err.stdout;
    }
    return JSON.parse(output);
  }
  async function close() {
    await Promise.all(roots.map(root=>cli(root,['stop']).catch(()=>{})));
    await rm(temp,{recursive:true,force:true});
  }
  return {roots,cli,close,home:env.PREVUE_HOME};
}
export async function digest(file) {return createHash('sha256').update(await readFile(file)).digest('hex');}
export async function treeNodes(result) {
  const {nodes}=JSON.parse(await readFile(result.treePath,'utf8'));
  const flat=[];
  function visit(node) {flat.push(node);node.children.forEach(visit);}
  nodes.forEach(visit);return flat;
}
export function center(node) {const b=node.bounds;return [String(Math.round(b.x+b.width/2)),String(Math.round(b.y+b.height/2))];}
export async function keep(file,name) {
  if(!process.env.PREVUE_DEMO_DIR) return;
  await mkdir(process.env.PREVUE_DEMO_DIR,{recursive:true});
  await cp(file,path.join(process.env.PREVUE_DEMO_DIR,name));
}
