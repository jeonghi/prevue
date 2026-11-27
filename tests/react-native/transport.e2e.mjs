import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { projects } from './projects.mjs';

test('concurrent launchers share a single owned server and skip an occupied port', {timeout:60000},async t=>{
  const suite=await projects(1);t.after(()=>suite.close());
  const root=await realpath(suite.roots[0]);
  const digest=createHash('sha256').update(root).update('\0').update('web').digest('hex');
  const port=32000+parseInt(digest.slice(0,8),16)%20000;
  const occupant=createServer((_req,res)=>res.end('different process'));
  await new Promise((resolve,reject)=>occupant.once('error',reject).listen(port,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>occupant.close(resolve)));
  const [a,b]=await Promise.all([1,2].map(()=>suite.cli(root,['show','OrderCard.preview.tsx'])));
  assert.ok(a.viewer===b.viewer,'Two simultaneous requests must receive the same session');
  const url=new URL(a.viewer);assert.notEqual(Number(url.port),port);
  assert.equal((await fetch(url.origin+'/viewer/state')).status,401);
  assert.equal((await fetch(url.origin+'/viewer/state',{headers:{origin:'https://example.invalid'}})).status,403);
  const response=await fetch(a.viewer,{redirect:'manual'});
  assert.equal(response.status,303); assert.ok(response.headers.get('set-cookie')?.includes('HttpOnly'));
  const cookie=response.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(url.origin+'/viewer/state',{headers:{cookie}})).status,200);
  assert.equal((await fetch(url.origin+'/command/stop',{method:'POST',headers:{cookie}})).status,403);
  assert.equal((await fetch(url.origin+'/artifacts/unknown.png',{headers:{cookie}})).status,404);
});
