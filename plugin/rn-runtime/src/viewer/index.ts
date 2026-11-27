import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ViewerHost, ViewerRoute } from '../protocol.ts';
import { galleryCard, previewFiles, projectFiles } from './files.ts';
import { events, stream } from './live.ts';
import { platformLabel, platformPreviews, viewerState } from './state.ts';

import { isAlive, loadInstance, location } from '../instance.ts';
import type { Platform } from '../protocol.ts';

const platforms: Platform[] = ['web', 'ios', 'android'];
async function liveSibling(root: string, target: Platform) {
  const loc = location(root,target);
  const record = await loadInstance(loc.record);
  return record?.root === root && record.platform === target && await isAlive(record,loc.key) ? record : null;
}
type Args = Record<string, unknown>;
function json(res: ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store'}).end(JSON.stringify(value));
}
function failure(res: ServerResponse, status: number, code: string, message: string) {
  json(res, {ok:false, error:{code, message}, message}, status);
}

async function body(req: IncomingMessage): Promise<Args> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > 64 * 1024) throw new Error('Viewer input exceeds 64 KiB');
    chunks.push(bytes);
  }
  if (!length) return {};
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Viewer intent requires a JSON object');
  return value as Args;
}

async function intent(res: ServerResponse, name: string, args: Args, host: ViewerHost) {
  const state = host.snapshot();
  const result = state.focusId && state.results[state.focusId];
  if (name === 'catchup') {
    if (!result || !result.treePath || result.status !== 'ready' || result.generation !== state.generation) {
      failure(res, 409, 'NO_CURRENT_TREE', 'No UI tree for the current render');
    } else json(res, {ok:true, treeUrl:host.artifactUrl(result.treePath)});
    return;
  }
  if (name === 'point' || name === 'selection') {
    const selected = typeof args.previewId === 'string' ? state.results[args.previewId] : result;
    if (args.treeUrl !== undefined && (!selected || !selected.treePath || host.artifactUrl(selected.treePath) !== args.treeUrl)) {
      failure(res, 409, 'STALE_TREE', 'The preview changed. Point at the updated image.');
      return;
    }
    await host.execute(name, {previewId:args.previewId, nodeId:args.nodeId, x:args.x, y:args.y,
      file:args.file ?? args.fileName, line:args.line, treePath:selected && selected.treePath});
    const selection = viewerState(host.snapshot(), host.artifactUrl).selection;
    if (selection) json(res, {...selection, ...!selection.file && {message:{t:'rn.sourceUnavailable'}}});
    else failure(res, 409, 'NO_SELECTION', 'No current selection');
    return;
  }
  let cmd = name;
  let input: Args = {};
  switch (name) {
    case 'open': cmd = 'show'; input = {file:args.file}; break;
    case 'tab': case 'close': input = {file:args.key}; break;
    case 'focus': input = {index:args.index, interactive:true}; break;
    case 'wheel': cmd = 'scroll'; input = args; break;
    case 'touch': case 'type': input = args; break;
    case 'exit': case 'reset': case 'render': break;
    case 'resize': case 'systemUi': case 'reveal': case 'choose': case 'cancel':
      failure(res, 501, 'UNSUPPORTED_INTENT', name + ' is unavailable in ' + platformLabel(state.platform)); return;
    default: failure(res, 404, 'UNKNOWN_INTENT', 'Unknown viewer intent ' + name); return;
  }
  const reply = await host.execute(cmd, input);
  if (name === 'open' && host.snapshot().activeFile === args.file) { json(res, {ok:true}); return; }
  if (reply && typeof reply === 'object' && 'ok' in reply && reply.ok === false) {
    const error = 'error' in reply ? reply.error : null;
    json(res, {ok:false, error, message:error && typeof error === 'object' && 'message' in error ? error.message : 'Preview failed'}, 409);
  } else json(res, {ok:true});
}

export const handleViewer: ViewerRoute = async (req, res, url, host) => {
  const {pathname} = url;
  if (req.method === 'GET') {
    const state = host.snapshot();
    switch (pathname) {
      case '/viewer/state': json(res, viewerState(state, host.artifactUrl)); break;
      case '/events': events(res, host); break;
      case '/stream': stream(res, url, host); break;
      case '/project-files.json': json(res, await projectFiles(state.projectRoot)); break;
      case '/preview-files.json': json(res, await previewFiles(state, host.artifactUrl)); break;
      case '/app.json': {
        const version = await readFile(new URL('../../../VERSION', import.meta.url), 'utf8');
        json(res, {name:basename(state.projectRoot), icon:false, prevue:version.trim(), reveal:false});
        break;
      }
      case '/rn/platforms': {
        const available = await Promise.all(platforms.map(async platform => ({
          platform, available: platform === state.platform || !!await liveSibling(state.projectRoot,platform),
        })));
        json(res, {platforms: available});
        break;
      }
      case '/rn/platform': {
        const target = platforms.find(platform => platform === url.searchParams.get('target'));
        const peer = target && await liveSibling(state.projectRoot,target);
        if (!peer) { failure(res,409,'RUNTIME_UNAVAILABLE','Start this project on the selected platform with prevue rn show'); break; }
        const query = new URLSearchParams({session:peer.token});
        if (url.searchParams.has('lang')) query.set('lang',url.searchParams.get('lang')!);
        res.writeHead(303, { Location:peer.url+'/?'+query, 'Cache-Control':'no-store' }).end();
        break;
      }
      case '/gallery/card': {
        const file = url.searchParams.get('file');
        const previews = platformPreviews(state).filter(p => p.source.file === file);
        if (!previews.length) { failure(res, 404, 'PREVIEW_NOT_FOUND', 'Unknown preview file'); break; }
        await host.execute('gallery', {file});
        const next = host.snapshot();
        json(res, galleryCard(platformPreviews(next).filter(p => p.source.file === file), next, host.artifactUrl));
        break;
      }
      default: return false;
    }
    return true;
  }
  if (req.method !== 'POST' || !(pathname === '/stream/viewport' || pathname.startsWith('/viewer/'))) return false;
  let args: Args;
  try { args = await body(req); } catch (error) {
    failure(res, 400, 'INVALID_BODY', error instanceof Error ? error.message : String(error)); return true;
  }
  if (pathname === '/stream/viewport') {
    // This is a display-bandwidth hint. The RN stream keeps the original screenshot resolution.
    json(res, {ok:true, downsampled:false});
  } else await intent(res, pathname.slice('/viewer/'.length), args, host);
  return true;
};
