import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parse } from '../src/commands.ts';
import { location, portCandidate } from '../src/instance.ts';
import { ProjectSession } from '../src/session.ts';
import type { Capabilities, PreviewRenderer, ProjectContext, RenderRequest, RenderResult } from '../src/protocol.ts';

test('isolates records, artifacts and ports by project and platform', () => {
  const a = location('/projects/a','web'), b = location('/projects/b','web'), i = location('/projects/a','ios');
  assert.notEqual(a.key,b.key);
  assert.notEqual(a.record,i.record);
  assert.equal(a.active,i.active);
  assert.notEqual(portCandidate(a.key,0),portCandidate(a.key,1));
});
test('CLI validates usage, forwards text literally and accepts a generation barrier', () => {
  assert.equal(parse(['wait','a.tsx','--after','14']).args?.after,14);
  assert.equal(parse(['type','--','--abc']).args?.text,'--abc');
  assert.throws(()=>parse(['focus','-2']));
  assert.throws(()=>parse(['show','a.tsx','--platform','watch']));
  assert.throws(()=>parse(['scroll','--direction','bad']));
  assert.ok(parse(['touch','--help']).help?.includes('<x> <y>'));
});

const caps: Capabilities={screenshot:true,interactiveInput:false,uiTree:false,sourceLocation:false,viewportResize:false,
  themeOverride:false,nativeInsets:false,animationFrameControl:false,stateReset:false};
test('an old acknowledgement or failed bundle never satisfies a save; a later generation recovers',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'prevue-session-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'A.preview.tsx');
  const source="import {definePreview} from '@prevue/react-native'; export const One=definePreview({render:()=>null});";
  await writeFile(path.join(dir,'package.json'),JSON.stringify({dependencies:{'react-native':'*'}}));
  await writeFile(file,source);
  let context!:ProjectContext, mode='ok';
  const renderer:PreviewRenderer={
    capabilities:()=>caps, prepare:async c=>{context=c;}, dispose:async()=>{},
    openSession:async()=>{throw Error('not used in this unit test');},
    render:async({preview,generation}:RenderRequest):Promise<RenderResult>=>{
      if(mode==='error') throw Object.assign(new Error('bad source'),{code:'BUNDLE_FAILED'});
      return {previewId:preview.id,generation:mode==='late'?generation-1:generation,platform:'web',status:'ready',sessionId:'unit',
        imagePath:path.join(dir,generation+'.png'),durationMs:1,height:20,width:20,warnings:[]};
    },
  };
  const core=new ProjectSession(dir,'web',renderer);
  await core.init(dir); t.after(()=>core.dispose());
  await core.execute('show',{file});
  const id=core.state.previews[0].id;
  assert.equal(core.state.results[id].imageGeneration,1);
  for(const [n,error] of [['late','STALE_RENDER'],['error','BUNDLE_FAILED']]) {
    mode=n;
    const before=core.state.generation;
    const pending=core.execute('wait',{file,after:before,timeout:2});
    context.changed(file);
    const answer=await pending as {ok:boolean};
    assert.equal(answer.ok,false);
    const result=core.state.results[id];
    assert.equal(result.status,'stale'); assert.equal(result.imageGeneration,1); assert.equal(result.error?.code,error);
  }
  mode='ok';const after=core.state.generation;context.changed(file);await core.execute('wait',{after});
  assert.equal(core.state.results[id].status,'ready');
  assert.equal(core.state.results[id].imageGeneration,after+1);
});
