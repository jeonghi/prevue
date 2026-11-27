import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import type { PreviewDescriptor, RenderResult, UINode, ViewerHost } from '../src/protocol.ts';
import { handleViewer } from '../src/viewer/index.ts';
import { viewerState, type ViewerSnapshot } from '../src/viewer/state.ts';

const file = 'cards/OrderCard.preview.tsx';
const other = 'search/Search.preview.jsx';
const node: UINode = {
  id:'n4', name:'TextInput', bounds:{x:10, y:20, width:80, height:30}, children:[], testId:'order-input',
  source:{file:'cards/OrderCard.tsx', line:29, column:3},
};
function descriptor(exportName: string, sourceFile = file): PreviewDescriptor {
  return {id:sourceFile + '#' + exportName, name:exportName, framework:'react-native', platforms:['web'],
    viewport:{width:200, height:150, pixelRatio:2}, source:{file:sourceFile, line:3, exportName}};
}

async function serve(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'prevue-viewer-test-'));
  const previews = [descriptor('Default'), descriptor('Error'), descriptor('Search', other),
    {...descriptor('NativeOnly'), platforms:['ios' as const]}];
  const state: ViewerSnapshot = {
    projectRoot:root, version:1, generation:8, platform:'web', previews,
    tabs:[file], activeFile:file, focusId:null, interactive:false, results:{}, busy:false, error:null, selection:null,
    capabilities:{screenshot:true, interactiveInput:true, uiTree:true, sourceLocation:true, viewportResize:false,
      themeOverride:false, nativeInsets:false, animationFrameControl:false, stateReset:true},
  };
  for (const name of [file, other, 'cards/OrderCard.tsx', 'node_modules/example/Ignore.tsx']) {
    await mkdir(path.dirname(path.join(root, name)), {recursive:true});
    await writeFile(path.join(root, name), '');
  }
  const makeResult = (p: PreviewDescriptor): RenderResult => ({
    previewId:p.id, sessionId:'session-' + p.name, generation:8, platform:'web', status:'ready', imageGeneration:8,
    imagePath:path.join(root, p.name + '.png'), treePath:path.join(root, p.name + '.json'),
    width:400, height:300, durationMs:18, warnings:[],
  });
  for (const p of previews.slice(0, 2)) state.results[p.id] = makeResult(p);
  const listeners = new Set<() => void>();
  const requests: {cmd:string; args:Record<string, unknown>}[] = [];
  function publish() { state.version++; for (const f of listeners) f(); }
  const host: ViewerHost = {
    snapshot:() => state,
    subscribe(f) { listeners.add(f); return () => { listeners.delete(f); }; },
    artifactUrl:f => '/artifacts/' + path.basename(f),
    async execute(cmd, args) {
      requests.push({cmd, args});
      if (cmd === 'gallery') {
        for (const p of previews.filter(p => p.source.file === args.file)) state.results[p.id] = makeResult(p);
      }
      if (cmd === 'point') { state.selection = node; state.selectionPreviewId = String(args.previewId); }
      publish();
      return {ok:true};
    },
  };
  const server = createServer((req, res) => {
    void handleViewer(req, res, new URL(req.url!, 'http://localhost'), host).then(found => {
      if (!found) res.writeHead(404).end();
    }).catch(err => { res.writeHead(500).end(String(err)); });
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = 'http://127.0.0.1:' + address.port;
  t.after(async () => {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
    await rm(root, {recursive:true, force:true});
  });
  function post(route: string, value: unknown) {
    return fetch(url + route, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(value)});
  }
  return {state, host, previews, requests, listeners, publish, url, post};
}

const composeFixture = (kind: string) => new URL('../../daemon/daemon/src/test/contract/viewer.state.' + kind + '.json', import.meta.url);

test('existing Board/Focus contract, immutable artifacts, density, stale states and selection', async t => {
  const {state, host, url, previews, post} = await serve(t);
  for (const kind of ['board', 'focus']) {
    if (kind === 'focus') { state.focusId = previews[1].id; state.interactive = true; }
    const view = await fetch(url + '/viewer/state').then(r => r.json());
    const fixture = JSON.parse(await readFile(composeFixture(kind), 'utf8')).example;
    for (const required of Object.keys(fixture)) assert.ok(required in view, required);
    for (const required of Object.keys(fixture.board.groups[0].cards[0])) assert.ok(required in view.board.groups[0].cards[0], required);
    assert.equal(view.screen, kind);
    assert.equal(view.header.variant, 'RN Web');
    assert.equal(view.board.groups[0].cards.length, 2);
    assert.equal(view.board.groups[0].cards[1].index, 1);
    assert.equal(view.board.groups[0].cards[1].widthDp, 200);
    if (kind === 'focus') {
      for (const required of Object.keys(fixture.focus)) assert.ok(required in view.focus, required);
      assert.equal(view.board.focus, 1);
      assert.equal(view.focus.pxPerDp, 2);
      assert.match(view.focus.streamUrl, /^\/stream\?/);
      assert.deepEqual(view.focus.postures, []);
      assert.equal(view.focus.systemUi, null);
    }
  }
  const treeUrl = viewerState(state, host.artifactUrl).focus!.treeUrl;
  const point = await post('/viewer/point', {previewId:previews[1].id, nodeId:node.id, treeUrl});
  const selected = await point.json();
  assert.equal(selected.ref, '@cards/OrderCard.tsx#L29');
  assert.equal(selected.nodeId, 'n4');
  assert.equal(selected.preview.index, 1);
  assert.deepEqual(selected.bounds, {x:10, y:20, w:80, h:30});
  assert.equal((await post('/viewer/point', {previewId:previews[1].id, nodeId:node.id, treeUrl:treeUrl+'-old'})).status, 409);
  assert.equal((await post('/viewer/catchup', {}).then(r => r.json())).treeUrl, treeUrl);
  state.generation++;
  const old = state.results[previews[1].id];
  Object.assign(old, {status:'stale', generation:9, error:{code:'BUNDLE', message:'Unexpected JSX token'}});
  const view = viewerState(state, host.artifactUrl);
  const card = view.board!.groups[0].cards[1];
  assert.equal(card.stale, true);
  assert.equal(card.ok, false);
  assert.deepEqual(card.freshness, {status:'stale', generation:9, imageGeneration:8});
  assert.equal(card.imageUrl, '/artifacts/Error.png');
  assert.equal(card.treeUrl, null);
  assert.equal(view.focus!.streamUrl, '');
  assert.equal((await post('/viewer/catchup', {})).status, 409);
  assert.deepEqual(view.stale[1].why, ['Unexpected JSX token']);
  state.activeFile = null; state.focusId = null; state.interactive = false; state.tabs = []; state.selection = null;
  assert.equal(viewerState(state, host.artifactUrl).screen, 'empty');
});

test('file search, lazy gallery covers and browser intents retain their wire shapes', async t => {
  const {state, url, post, requests} = await serve(t);
  const index = await fetch(url + '/project-files.json').then(r => r.json());
  assert.deepEqual(index.files['OrderCard.tsx'], ['cards/OrderCard.tsx']);
  assert.equal(index.files['Ignore.tsx'], undefined);
  const list = await fetch(url + '/preview-files.json').then(r => r.json());
  assert.equal(list.ready, true);
  assert.deepEqual(list.files[0].functions, ['Default', 'Error']);
  assert.deepEqual(list.files[0].previews[1], {fn:'Error', calls:[]});
  assert.equal(list.files[0].shots.sheets, 2);
  const entry = list.files.find((f: {path:string}) => f.path === other);
  assert.equal(entry.shots, null);
  const gallery = await fetch(url + '/gallery/card?file=' + encodeURIComponent(other)).then(r => r.json());
  assert.deepEqual(gallery.front[0], {i:0, name:'Search', variant:'Search', image:{url:'/artifacts/Search.png', w:400, h:300, stale:false}});
  assert.equal((await fetch(url + '/gallery/card?file=unknown')).status, 404);
  assert.deepEqual(state.tabs, [file]);
  assert.equal(state.activeFile, file);
  for (const [intent, input] of [
    ['focus', {index:1}], ['touch', {x:12, y:31, type:'press'}], ['wheel', {x:3,y:5,dx:0,dy:15}],
    ['type', {text:'부산'}], ['reset', {}], ['exit', {}], ['open', {file:other}], ['tab', {key:file}], ['close', {key:file}],
  ] as const) assert.equal((await post('/viewer/' + intent, input)).status, 200, intent);
  assert.deepEqual(requests.map(r => r.cmd), ['gallery','focus','touch','scroll','type','reset','exit','show','tab','close']);
  assert.deepEqual(requests[1].args, {index:1, interactive:true});
  assert.deepEqual(requests[4].args, {text:'부산'});
  assert.deepEqual(requests.at(-1)?.args, {file});
  const before = requests.length;
  assert.equal((await post('/stream/viewport', {width:99,viewer:'u'}).then(r => r.json())).downsampled, false);
  for (const intent of ['resize', 'systemUi', 'reveal']) assert.equal((await post('/viewer/'+intent, {})).status, 501);
  assert.equal(requests.length, before);
  assert.equal((await post('/viewer/unknown', {})).status, 404);
  assert.equal((await post('/viewer/touch', null)).status, 400);
  assert.ok((await fetch(url + '/app.json').then(r => r.json())).prevue);
});

test('SSE sends the initial and newest full state, file changes and a stable boot id', {timeout:6000}, async t => {
  const {url, state, publish, listeners} = await serve(t);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(url + '/events', {signal:controller.signal});
  assert.match(response.headers.get('Content-Type')!, /^text\/event-stream/);
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let pending = '';
  async function next() {
    while (!pending.includes('\n\n')) { const part = await reader.read(); assert.equal(part.done, false); pending += part.value; }
    const end = pending.indexOf('\n\n');
    const event = JSON.parse(pending.slice(6,end));
    pending = pending.slice(end+2);
    return event;
  }
  const initial = await next();
  assert.equal(initial.type, 'state');
  assert.equal(initial.state.version, state.version);
  assert.ok(initial.state.boot);
  state.generation++;
  publish();
  const updated = await next();
  assert.equal(updated.state.version, initial.state.version+1);
  assert.equal(updated.state.boot, initial.state.boot);
  assert.equal(updated.state.board.groups[0].cards[0].stale, true);
  assert.deepEqual(await next(), {type:'ui', event:{kind:'previewFiles'}});
  assert.deepEqual(await next(), {type:'ui', event:{kind:'projectFiles'}});
  await reader.cancel();
  await eventually(() => listeners.size === 0);
});

async function eventually(condition: () => boolean) {
  for (let i=0; i<100 && !condition(); i++) await new Promise(r => setTimeout(r,10));
  assert.ok(condition());
}

test('PNG stream sends current immutable frames and releases clients when focus changes', {timeout:6000}, async t => {
  const {url, state, previews, publish, listeners} = await serve(t);
  assert.equal((await fetch(url + '/stream')).status, 409);
  const id = previews[0].id;
  state.focusId = id; state.interactive = true;
  const result = state.results[id];
  // Streaming is opaque to pixel content. Distinct payloads identify the captures in this transport test.
  await writeFile(result.imagePath!, 'frame-one');
  const response = await fetch(url + '/stream?v=client');
  assert.match(response.headers.get('Content-Type')!, /multipart\/x-mixed-replace; boundary=prevueframe/);
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  async function through(expected: string) {
    let data = '';
    while (!data.includes(expected)) { const part = await reader.read(); assert.equal(part.done, false); data += part.value; }
    return data;
  }
  const first = await through('frame-one\r\n--prevueframe\r\n');
  assert.ok(first.endsWith('--prevueframe\r\nContent-Type: image/png\r\n\r\n'));
  result.imagePath = path.join(state.projectRoot, 'next.png');
  await writeFile(result.imagePath, 'frame-two');
  publish();
  assert.match(await through('frame-two'), /Content-Type: image\/png/);
  state.focusId = null; state.interactive = false; publish();
  while (!(await reader.read()).done) { /* drain trailing boundary */ }
  await eventually(() => listeners.size === 0);
});

test('platform list redirects only to a running sibling and exposes native rebuild state', async t => {
  const {state,url} = await serve(t);
  const {location,atomicWrite} = await import('../src/instance.ts');
  const previous = process.env.PREVUE_HOME;
  process.env.PREVUE_HOME = path.join(state.projectRoot,'session-state');
  t.after(() => { if(previous===undefined) delete process.env.PREVUE_HOME; else process.env.PREVUE_HOME=previous; });
  const loc = location(state.projectRoot,'android');
  const other = createServer((req,res)=>{
    if (req.url === '/health' && req.headers.authorization === 'Bearer fixture-token') res.end(JSON.stringify({key:loc.key}));
    else res.writeHead(403).end();
  }).listen(0,'127.0.0.1');
  await once(other,'listening');
  t.after(()=>new Promise<void>(resolve=>other.close(()=>resolve())));
  const address=other.address(); assert.ok(address && typeof address === 'object');
  const target='http://127.0.0.1:'+address.port;
  await mkdir(loc.dir,{recursive:true});
  await atomicWrite(loc.record,JSON.stringify({root:state.projectRoot,key:loc.key,platform:'android',url:target,token:'fixture-token'}));
  const list=await (await fetch(url+'/rn/platforms')).json();
  assert.deepEqual(list.platforms.filter((p:{available:boolean})=>p.available).map((p:{platform:string})=>p.platform),['web','android']);
  const link=await fetch(url+'/rn/platform?target=android&lang=ko',{redirect:'manual'});
  assert.equal(link.status,303); assert.equal(new URL(link.headers.get('location')!).origin,target);
  assert.equal((await fetch(url+'/rn/platform?target=ios')).status,409);
  state.error={code:'NATIVE_BUILD_REQUIRED',message:'Reinstall the Debug Host'};
  assert.equal((await (await fetch(url+'/viewer/state')).json()).runtime.rebuildRequired,true);
});
