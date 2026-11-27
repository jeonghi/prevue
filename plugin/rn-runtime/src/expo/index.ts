import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { watch } from 'chokidar';
import type { ProjectContext } from '../protocol.ts';
import { createWebRenderer } from '../web/index.ts';
import type { WebBundler } from '../web/bundler.ts';
import { WebError } from '../web/bridge.ts';

const exec = promisify(execFile);
async function startMetro(context: ProjectContext): Promise<WebBundler> {
  const root = await realpath(context.root);
  const config = await readFile(path.join(root, 'prevue.expo.json'), 'utf8').catch(() => {
    throw new WebError(
      'EXPO_ENTRY_REQUIRED',
      'Add prevue.expo.json with an explicit development-only Metro preview entry'
    );
  });
  const { entry } = JSON.parse(config);
  if (typeof entry !== 'string' || !entry)
    throw new WebError('EXPO_ENTRY_REQUIRED', 'A project-relative Expo preview entry is required');
  const source = await realpath(path.resolve(root, entry));
  if (!source.startsWith(root + path.sep))
    throw new WebError('OUTSIDE_PROJECT', 'Expo entry must be inside the project');
  const req = createRequire(path.join(root, 'package.json'));
  const cli = path.join(path.dirname(req.resolve('expo/package.json')), 'bin/cli');
  const folder = path.join(context.artifacts, 'metro-web');
  const base = '/' + randomUUID() + '/';
  let revision = 0,
    origin = '';
  const abort = new AbortController();
  const builds = new Map<number, Promise<void>>();
  const types: Record<string, string> = {
    '.js': 'text/javascript;charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2',
  };
  const js = {
    'browser.js': new URL('./browser.js', import.meta.url),
    'tree.js': new URL('../web/tree.js', import.meta.url),
  };
  const html =
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#prevue-root{height:100%;margin:0}#prevue-root{display:flex;flex-direction:column}</style><div id="prevue-root"></div><script type="module" src="./browser.js"></script>';
  const http = createServer((request, response) => {
    async function send() {
      const url = new URL(request.url ?? '', origin);
      if (
        request.headers.host !== new URL(origin).host ||
        request.method !== 'GET' ||
        !url.pathname.startsWith(base)
      ) {
        response.writeHead(404).end();
        return;
      }
      const rel = url.pathname.slice(base.length);
      response.setHeader('cache-control', 'no-store');
      response.setHeader(
        'content-security-policy',
        "default-src 'none';script-src 'self';style-src 'self' 'unsafe-inline';img-src 'self' data: blob:;font-src 'self' data:;connect-src 'self';frame-ancestors 'none';base-uri 'none'"
      );
      if (rel === 'index.html') {
        response.setHeader('content-type', 'text/html;charset=utf-8');
        response.end(html);
        return;
      }
      if (rel === 'browser.js' || rel === 'tree.js') {
        response.setHeader('content-type', types['.js']);
        response.end(await readFile(js[rel]));
        return;
      }
      const match = /^r(\d+)\/(.+)$/.exec(rel);
      if (!match || !builds.has(Number(match[1]))) {
        response.writeHead(404).end();
        return;
      }
      const generated = path.join(folder, match[1]);
      const target = await realpath(path.resolve(generated, decodeURIComponent(match[2])));
      if (!target.startsWith(generated + path.sep)) {
        response.writeHead(403).end();
        return;
      }
      response.setHeader('content-type', types[path.extname(target)] ?? 'application/octet-stream');
      response.end(await readFile(target));
    }
    void send().catch(() => response.writeHead(404).end());
  });
  const watcher = watch(root, {
    ignoreInitial: true,
    followSymlinks: false,
    ignored: (p) =>
      p.split(path.sep).some((n) => ['.git', '.expo', 'node_modules', 'build', 'dist', 'Pods'].includes(n)),
  });
  watcher.on('all', (event, file) => {
    if (
      (event === 'add' || event === 'unlink' || event === 'change') &&
      /\.(?:[jt]sx?|json|png|svg|jpg)$/.test(file)
    ) {
      revision++;
      context.changed(file);
    }
  });
  await Promise.all([
    new Promise<void>((resolve) => watcher.once('ready', resolve)),
    new Promise<void>((resolve, reject) => http.once('error', reject).listen(0, '127.0.0.1', resolve)),
  ]);
  const address = http.address();
  if (!address || typeof address === 'string')
    throw new WebError('EXPO_SERVER_FAILED', 'Metro preview HTTP port unavailable');
  origin = 'http://127.0.0.1:' + address.port;
  async function build(target: number) {
    const out = path.join(folder, String(target));
    await mkdir(out, { recursive: true });
    try {
      await exec(
        process.execPath,
        [
          cli,
          'export:embed',
          '--entry-file',
          source,
          '--platform',
          'web',
          '--dev',
          'false',
          '--minify',
          'false',
          '--max-workers',
          '2',
          '--bundle-output',
          path.join(out, 'bundle.js'),
          '--assets-dest',
          out,
        ],
        {
          cwd: root,
          signal: abort.signal,
          timeout: 90000,
          maxBuffer: 4 * 1024 * 1024,
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            TMPDIR: process.env.TMPDIR,
            LANG: process.env.LANG,
            CI: '1',
            EXPO_NO_DOTENV: '1',
            EXPO_NO_TELEMETRY: '1',
            EXPO_OFFLINE: '1',
          },
        }
      );
    } catch (err) {
      const report = err as Error & { stderr?: string; stdout?: string };
      throw new WebError(
        'EXPO_BUNDLE_FAILED',
        (report.stderr || report.stdout || report.message).slice(-4000)
      );
    }
  }
  return {
    entry: origin + base + 'index.html',
    reloadOnChange: true,
    revision: () => revision,
    async request({ preview, generation }, target) {
      if (preview.format === 'csf')
        throw new WebError(
          'UNSUPPORTED_STORY',
          'The Expo preview entry requires a registered definePreview export'
        );
      let pending = builds.get(target);
      if (!pending) {
        pending = build(target);
        builds.set(target, pending);
      }
      await pending;
      if (target !== revision)
        throw new WebError('STALE_GENERATION', 'A newer Expo source revision is available');
      const moduleUrl =
        origin + base + 'r' + target + '/bundle.js?file=' + encodeURIComponent(preview.source.file);
      return {
        previewId: preview.id,
        exportName: preview.source.exportName,
        moduleUrl,
        generation,
        revision: target,
      };
    },
    async close() {
      abort.abort();
      await watcher.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
export function createExpoRenderer() {
  return createWebRenderer(startMetro);
}
