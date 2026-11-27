import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import type { ViewerHost } from '../protocol.ts';
import { viewerState } from './state.ts';

const boot = randomUUID();
const boundary = 'prevueframe';
const viewers = new WeakMap<ViewerHost, Map<string, ServerResponse>>();

export function events(res: ServerResponse, host: ViewerHost) {
  res.writeHead(200, {'Content-Type':'text/event-stream; charset=utf-8', 'Cache-Control':'no-store', 'X-Accel-Buffering':'no'});
  let blocked = false, version = -1, generation = -1, files = '', shots = '';
  function send() {
    if (blocked || res.destroyed || res.writableEnded) return;
    const next = host.snapshot();
    if (version === next.version) return;
    const nextFiles = JSON.stringify(next.previews.map(p => [p.id, p.name, p.platforms]));
    const nextShots = JSON.stringify(Object.values(next.results).map(r => [r.imagePath, r.status]));
    const ui: string[] = [];
    if (version !== -1) {
      if (files !== nextFiles || generation !== next.generation) ui.push('previewFiles', 'projectFiles');
      else if (shots !== nextShots) ui.push('galleryShots');
    }
    version = next.version; generation = next.generation; files = nextFiles; shots = nextShots;
    const state = {...viewerState(next, host.artifactUrl), boot};
    const lines = [{type:'state', state}, ...ui.map(kind => ({type:'ui', event:{kind}}))];
    blocked = !res.write(lines.map(line => 'data: ' + JSON.stringify(line) + '\n\n').join(''));
  }
  // A slow client will receive the latest full state when its socket drains.
  res.on('drain', () => { blocked = false; send(); });
  const off = host.subscribe(send);
  const keepalive = setInterval(() => { if (!blocked) blocked = !res.write(': keepalive\n\n'); }, 15000);
  keepalive.unref();
  res.once('close', () => { off(); clearInterval(keepalive); });
  res.on('error', () => res.destroy());
  send();
}

export function stream(res: ServerResponse, url: URL, host: ViewerHost) {
  const initial = host.snapshot();
  const id = initial.focusId;
  const session = id && initial.results[id]?.sessionId;
  const requested = url.searchParams;
  if (!id || !session || !initial.interactive || !initial.results[id]?.imagePath ||
      (requested.has('preview') && requested.get('preview') !== id) ||
      (requested.has('session') && requested.get('session') !== session) ||
      (requested.has('generation') && requested.get('generation') !== String(initial.generation))) {
    res.writeHead(409, {'Content-Type':'application/json'}).end(JSON.stringify({ok:false, error:'NO_ACTIVE_STREAM'}));
    return;
  }
  res.writeHead(200, {'Content-Type':`multipart/x-mixed-replace; boundary=${boundary}`, 'Cache-Control':'no-store'});
  // Chromium publishes the preceding image after it has parsed the next part's headers.
  const part = Buffer.from('--' + boundary + '\r\nContent-Type: image/png\r\n\r\n');
  res.write(part);
  const viewer = requested.get('v');
  let clients = viewers.get(host);
  if (!clients) { clients = new Map(); viewers.set(host, clients); }
  if (viewer) { clients.get(viewer)?.end(); clients.set(viewer, res); }
  let reading = false, blocked = false, sent: string | undefined;
  const frame = () => {
    const state = host.snapshot();
    const result = state.results[id];
    return state.focusId === id && state.interactive && result?.sessionId === session && result.status === 'ready' &&
      result.generation === state.generation ? result.imagePath : undefined;
  };
  async function send() {
    if (reading || blocked || res.destroyed || res.writableEnded) return;
    const path = frame();
    if (!path) { res.end(); return; }
    if (sent === path) return;
    reading = true;
    try {
      const bytes = await readFile(path);
      if (path === frame() && !res.destroyed && !res.writableEnded) {
        sent = path;
        blocked = !res.write(Buffer.concat([bytes, Buffer.from('\r\n'), part]));
      }
    } catch (error) {
      res.destroy(error instanceof Error ? error : new Error(String(error)));
    } finally {
      reading = false;
    }
    if (!res.destroyed && !res.writableEnded && !blocked) {
      const newest = frame();
      if (!newest || newest !== sent) void send();
    }
  }
  const off = host.subscribe(() => { void send(); });
  res.on('drain', () => { blocked = false; void send(); });
  res.on('error', () => res.destroy());
  res.once('close', () => { off(); if (viewer && clients.get(viewer) === res) clients.delete(viewer); });
  void send();
}
