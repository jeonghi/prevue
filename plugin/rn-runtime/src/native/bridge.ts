import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { PreviewFailure } from '../errors.ts';

export interface NativeCommand {
  id: string;
  action: 'open' | 'capture' | 'reset' | 'args' | 'close';
  revision: string;
  previewId: string;
  generation: number;
  sessionId: string;
  args?: Record<string, unknown>;
}
export interface Screen { width: number; height: number; scale: number }

export async function startBridge(platform: 'ios' | 'android') {
  const token = randomBytes(32).toString('hex');
  const auth = Buffer.from('Bearer ' + token);
  const events = new EventEmitter();
  let pending: { command: NativeCommand; started: number; resolve(screen: Screen): void; reject(error: Error): void } | undefined;
  let endpoint = '';
  function send(res: ServerResponse, status: number, data?: unknown) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(data));
  }
  async function route(req: IncomingMessage, res: ServerResponse) {
    const supplied = Buffer.from(req.headers.authorization ?? '');
    if (auth.length !== supplied.length || !timingSafeEqual(auth, supplied) ||
        req.headers.origin || 'http://' + req.headers.host !== endpoint) return send(res, 403);
    const url = new URL(req.url ?? '/', endpoint);
    if (req.method === 'GET' && url.pathname === '/next') {
      const revision = url.searchParams.get('revision');
      const reply = () => {
        if (!pending || pending.command.id === url.searchParams.get('after')) return false;
        if (revision === pending.command.revision) { send(res, 200, pending.command); return true; }
        // A host with Fast Refresh disabled can load the new bundle, then prove its revision by acknowledging it.
        if (Date.now() - pending.started > 3000) { send(res, 200, { action: 'reload', revision: pending.command.revision }); return true; }
        return false;
      };
      if (reply()) return;
      const onCommand = () => { if (reply()) cleanup(); };
      const timer = setTimeout(() => { if (!reply()) send(res, 204); cleanup(); }, 4000);
      function cleanup() { clearTimeout(timer); events.off('command', onCommand); }
      events.on('command', onCommand);
      res.on('close', cleanup);
      return;
    }
    if (req.method !== 'POST' || url.pathname !== '/ack') return send(res, 404);
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 16_384) return send(res, 413);
      chunks.push(chunk);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString());
    const command = pending?.command;
    if (!pending || !command || !value || value.id !== command.id || value.revision !== command.revision ||
        value.generation !== command.generation || value.previewId !== command.previewId ||
        value.sessionId !== command.sessionId || value.platform !== platform) return send(res, 409);
    if (value.error && typeof value.error === 'string') {
      pending.reject(new PreviewFailure('NATIVE_RENDER_FAILED', value.error));
    } else {
      const screen = value.screen;
      if (!screen || ![screen.width, screen.height, screen.scale].every(n => Number.isFinite(n) && n > 0)) return send(res, 400);
      pending.resolve({ width: screen.width, height: screen.height, scale: screen.scale });
    }
    pending = undefined;
    send(res, 200, { ok: true });
  }
  const server = createServer((req, res) => { void route(req, res).catch(() => send(res, 400)); });
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing native bridge address');
  endpoint = 'http://127.0.0.1:' + address.port;
  return {
    endpoint, token, port: address.port,
    request(input: Omit<NativeCommand, 'id'>, timeout = 45_000): Promise<Screen> {
      if (pending) return Promise.reject(new PreviewFailure('NATIVE_DEVICE_BUSY', 'A native command is already in flight.'));
      const command = { ...input, id: randomUUID() };
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pending?.command.id === command.id) pending = undefined;
          reject(new PreviewFailure('NATIVE_ACK_TIMEOUT', 'The debug host did not commit the requested preview revision. Check Metro and the debug host on the selected device.'));
        }, timeout);
        pending = { command, started: Date.now(), resolve: screen => { clearTimeout(timer); resolve(screen); },
          reject: error => { clearTimeout(timer); reject(error); } };
        events.emit('command');
      });
    },
    close() {
      pending?.reject(new PreviewFailure('NATIVE_DISCONNECTED', 'Native bridge closed.'));
      pending = undefined;
      server.closeAllConnections();
      server.close();
    },
  };
}
