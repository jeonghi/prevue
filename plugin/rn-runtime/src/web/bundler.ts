import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformAsync } from '@babel/core';
import react from '@vitejs/plugin-react';
import { createServer, normalizePath, searchForWorkspaceRoot, transformWithEsbuild, type Plugin, type ViteDevServer } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';
import type { ProjectContext, RenderRequest } from '../protocol.ts';
import { metroAssets } from './assets.ts';
import { WebError, type WebRequest } from './bridge.ts';
import { SavedFiles } from './saved-files.ts';

export interface WebBundler {
  entry: string;
  revision(): number;
  reloadOnChange?: boolean;
  diagnostics?(id: string, report: (revision: number, message: string) => void): () => void;
  request(request: RenderRequest, revision: number): Promise<WebRequest>;
  close(): Promise<void>;
}

const extensions = ['.web.tsx', '.web.ts', '.web.jsx', '.web.js', '.web.mjs', '.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json'];
const previewExtension = /\.preview\.[jt]sx$/;
const trackedSource = /\.(?:[cm]?[jt]sx?|json|css|s[ac]ss|less|avif|gif|jpe?g|png|svg|webp|otf|ttf|woff2?|mp[34]|webm)$/i;
const loopback = '127.0.0.1';

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}

export async function startBundler(context: ProjectContext): Promise<WebBundler> {
  const root = await realpath(context.root);
  const workspace = searchForWorkspaceRoot(root);
  const artifacts = path.resolve(context.artifacts);
  const cacheDir = path.join(artifacts, 'vite-cache');
  const projectRequire = createRequire(path.join(root, 'package.json'));
  for (const name of ['react', 'react-dom/client', 'react-native-web']) {
    try { projectRequire.resolve(name); }
    catch { throw new WebError('WEB_DEPENDENCY_MISSING', 'Install ' + name.replace('/client', '') + ' in the preview project.'); }
  }
  const sdk = fileURLToPath(new URL('../../packages/react-native/index.js', import.meta.url));
  const internal = '.prevue-web-' + randomUUID();
  const base = '/preview-' + randomUUID() + '/';
  const id = (file: string) => normalizePath(path.join(root, internal, file));
  const clientId = id('client.jsx');
  const revisionId = id('revision.jsx');
  const treeId = id('tree.js');
  const sdkId = id('sdk.js');
  const saves = new SavedFiles();
  const sharedDirectories = new Set<string>();
  let revision = 0;
  const requestedAt = new WeakMap<IncomingMessage, number>();
  const diagnostics = new Map<string, (revision: number, message: string) => void>();
  let vite: ViteDevServer | undefined;
  const http = createHttpServer((req, res) => {
    const requestPath = req.url?.split('?')[0] ?? '';
    if (!vite || req.headers.host !== authority || !requestPath.startsWith(base) ||
        requestPath.slice(base.length).startsWith('__') || !['GET', 'HEAD'].includes(req.method ?? '')) {
      res.writeHead(404).end();
      return;
    }
    if (requestPath !== base + 'index.html') {
      requestedAt.set(req, revision);
      vite.middlewares(req, res, () => res.writeHead(404).end());
      return;
    }
    const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<style>:root{color-scheme:light dark}html,body,#prevue-root{height:100%;width:100%;margin:0}#prevue-root{display:flex;flex-direction:column}body{background:Canvas}</style></head>' +
      '<body><div id="prevue-root"></div><script type="module" src="/' + internal + '/client.jsx"></script></body></html>';
    void vite.transformIndexHtml('/index.html', html).then(transformed => {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
          "img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; connect-src 'self' ws://" +
          authority + "; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      });
      res.end(transformed);
    }).catch((error: Error) => res.writeHead(500).end(error.message));
  });
  let authority = '';
  await new Promise<void>((resolve, reject) => http.once('error', reject).listen(0, loopback, resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new WebError('WEB_SERVER_FAILED', 'Missing Vite loopback address.');
  authority = loopback + ':' + address.port;

  const runtime: Plugin = {
    name: 'prevue-web-runtime',
    enforce: 'pre',
    configureServer(server) {
      // Vite's middleware mode forwards transform errors to the parent as plain
      // 404s. Preserve the compiler diagnostic for the requesting browser only.
      return () => server.middlewares.use((error: Error, req: IncomingMessage, res: ServerResponse, _next: (error?: Error) => void) => {
        const session = req.headers['x-prevue-session'];
        if (typeof session === 'string') diagnostics.get(session)?.(requestedAt.get(req) ?? revision, error.message);
        server.config.logger.error(error.message);
        res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ message: error.message }));
      });
    },
    resolveId(source, importer) {
      if (source === '@prevue/react-native') return sdkId;
      if (source === '/' + internal + '/client.jsx') return clientId;
      if (importer === clientId && source === './revision.jsx') return revisionId;
      if (importer === clientId && source === './tree.js') return treeId;
    },
    load(moduleId) {
      if (moduleId === clientId) return readFile(new URL('./client.jsx', import.meta.url), 'utf8');
      if (moduleId === treeId) return readFile(new URL('./tree.js', import.meta.url), 'utf8');
      if (moduleId === sdkId) return readFile(existsSync(sdk) ? sdk : projectRequire.resolve('@prevue/react-native'), 'utf8');
      if (moduleId === revisionId) return [
        "import { useLayoutEffect } from 'react';",
        'export function Revision({ report }) {',
        '  useLayoutEffect(() => report(' + revision + '));',
        '  return null;',
        '}',
      ].join('\n');
    },
    async transform(code, moduleId) {
      const file = moduleId.split('?')[0];
      if (!inside(workspace, file) || !/\.[cm]?[jt]sx?$/.test(file) || file.includes('/node_modules/') || inside(cacheDir, file)) return;
      // Linux watches an individual file's inode. Watch the parent of imported
      // workspace modules as well so replacing a file keeps it under observation.
      const directory = path.dirname(file);
      if (!inside(root, file) && !sharedDirectories.has(directory)) {
        sharedDirectories.add(directory);
        vite?.watcher.add(directory);
      }
      let map;
      if (code.includes('require') && /\brequire\s*\(/.test(code)) {
        const result = await transformAsync(code, {
          filename: file, babelrc: false, configFile: false, sourceMaps: true, retainLines: true,
          parserOpts: { plugins: ['jsx', 'typescript'] }, plugins: [metroAssets],
        });
        if (result?.code) { code = result.code; map = result.map; }
      }
      if (previewExtension.test(file)) {
        // Fast Refresh normally registers component exports. Providers nested in SDK
        // data exports need the same stable family when their module is re-evaluated.
        const refresh = [
          'import { getRefreshReg as __prevueRegisterFor } from "/@react-refresh";',
          'if (import.meta.hot) {',
          '  const register = __prevueRegisterFor(new URL(import.meta.url).pathname);',
          '  const providers = exports => {',
          '    for (const [name, preview] of Object.entries(exports ?? {})) {',
          '      if (typeof preview?.render === "function" && preview.provider) register(preview.provider, name + ".provider");',
          '    }',
          '  };',
          '  import.meta.hot.accept(providers);',
          '}',
        ].join('\n');
        return { code: code + '\n' + refresh, map: map ?? null };
      }
      // Metro projects often author JSX in .js files.
      if (file.endsWith('.js')) {
        return transformWithEsbuild(code, file, { loader: 'jsx', jsx: 'automatic', jsxDev: true }, map ?? undefined);
      }
      if (map) return { code, map };
    },
    async hotUpdate({ file, modules, timestamp }) {
      if (this.environment.name !== 'client' || !inside(workspace, file) || inside(artifacts, file) ||
          file.split('/').includes('node_modules') || !trackedSource.test(file)) return;
      if (!await saves.changed(file)) return [];
      revision++;
      const graph = this.environment.moduleGraph;
      const marker = graph.getModuleById(revisionId);
      const updates = marker ? [...new Set([...modules, marker])] : modules;
      const seen = new Set<typeof modules[number]>();
      for (const mod of updates) graph.invalidateModule(mod, seen, timestamp, true);
      // Re-evaluate affected definitions in the same HMR batch as their components
      // and the revision marker, including descriptors containing inline providers.
      const definitions = [...seen].filter(mod => mod.file && previewExtension.test(mod.file));
      context.changed(file);
      return [...new Set([...updates, ...definitions])];
    },
  };

  async function close() {
    try { await vite?.close(); }
    finally {
      http.closeAllConnections();
      await new Promise<void>(resolve => http.close(() => resolve()));
    }
  }
  try {
    vite = await createServer({
      root, base, cacheDir, configFile: false, envFile: false, envDir: false, appType: 'custom',
      logLevel: 'error', clearScreen: false,
      plugins: [
        runtime, tsconfigPaths({ loose: true }),
        react({ exclude: [previewExtension, clientId, normalizePath(cacheDir) + '/**'] }),
      ],
      resolve: { alias: [{ find: /^react-native$/, replacement: 'react-native-web' }], extensions, dedupe: ['react', 'react-dom', 'react-native-web'] },
      define: { __DEV__: true },
      optimizeDeps: { entries: [], include: ['react-dom/client', 'react-native-web'], exclude: ['@prevue/react-native'] },
      server: {
        host: loopback, middlewareMode: true, cors: false,
        hmr: { server: http, host: loopback, clientPort: address.port, overlay: false },
        fs: { strict: true, allow: [workspace, cacheDir] },
        watch: {
          ignored: [normalizePath(artifacts) + '/**'],
          // Coalesce a truncate/write and observe the next completed save even if
          // it follows a compiler error inside chokidar's default change throttle.
          awaitWriteFinish: { stabilityThreshold: 35, pollInterval: 10 },
        },
      },
    });
    const server = vite;
    const projectUrl = (file: string) => {
      const url = base + normalizePath(path.relative(root, file)).split('/').map(encodeURIComponent).join('/');
      const mods = server.environments.client.moduleGraph.getModulesByFile(normalizePath(file));
      const stamp = Math.max(0, ...Array.from(mods ?? [], mod => mod.lastHMRTimestamp));
      return stamp ? url + '?t=' + stamp : url;
    };
    return {
      entry: 'http://' + authority + base + 'index.html', revision: () => revision, close,
      diagnostics(id, report) {
        diagnostics.set(id, report);
        return () => { diagnostics.delete(id); };
      },
      async request({ preview, generation }, sourceRevision) {
        const source = await realpath(path.resolve(root, preview.source.file));
        if (!inside(root, source) || !previewExtension.test(source)) throw new WebError('INVALID_PREVIEW', 'Expected a project-relative .preview.tsx or .preview.jsx file.');
        const provider = path.join(root, 'prevue.providers.tsx');
        return {
          previewId: preview.id, generation, revision: sourceRevision,
          exportName: preview.source.exportName, moduleUrl: projectUrl(source),
          providerUrl: existsSync(provider) ? projectUrl(provider) : undefined,
        };
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
