import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import type { Interaction, PreviewSession, RenderRequest, RenderResult, UITree } from '../protocol.ts';
import { describeError, WebError, type BrowserBridge } from './bridge.ts';
import { resolveSources } from './inspector.ts';
import type { WebBundler } from './bundler.ts';

export interface Ticket {
  request: RenderRequest;
  revision: number;
  check(): void;
}

function dimensions({ preview }: RenderRequest) {
  const { width = 390, height = 844, pixelRatio = 1 } = preview.viewport ?? {};
  return { width, height, pixelRatio };
}

export function failed(ticket: Ticket, id: string, started: number, error: unknown): RenderResult {
  const detail = describeError(error);
  const { preview, generation } = ticket.request;
  const { width, height, pixelRatio } = dimensions(ticket.request);
  return {
    previewId: preview.id, generation, sessionId: id, platform: 'web',
    status: detail.code === 'STALE_GENERATION' ? 'stale' : 'error', error: detail,
    width: Math.round(width * pixelRatio), height: Math.round(height * pixelRatio),
    durationMs: Math.round(performance.now() - started), warnings: [],
  };
}

type Surface = {
  context: BrowserContext; page: Page; pixelRatio: number;
  moduleError(revision: number): string | undefined;
};
async function surface(browser: Browser, bundle: WebBundler, request: RenderRequest): Promise<Surface> {
  const entry = bundle.entry;
  const id = randomUUID();
  const { width, height, pixelRatio } = dimensions(request);
  const context = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: pixelRatio, colorScheme: request.preview.theme ?? 'light',
    serviceWorkers: 'block', acceptDownloads: false, extraHTTPHeaders: { 'X-Prevue-Session': id },
  });
  let failure: { revision: number; message: string } | undefined;
  const detach = bundle.diagnostics?.(id, (revision, message) => { failure = { revision, message }; });
  if (detach) context.once('close', detach);
  const moduleError = (revision: number) => failure?.revision === revision ? failure.message : undefined;
  try {
    const base = new URL('.', entry);
    await context.route('**/*', route => {
      const request = route.request();
      const url = new URL(request.url());
      const allowed = url.origin === base.origin && url.pathname.startsWith(base.pathname) &&
        ['GET', 'HEAD'].includes(request.method()) && (!request.isNavigationRequest() || url.href === entry);
      return allowed ? route.continue() : route.abort('blockedbyclient');
    });
    await context.routeWebSocket(/.*/, socket => {
      const url = new URL(socket.url());
      if (url.protocol === 'ws:' && url.host === base.host && url.pathname === base.pathname) {
        socket.connectToServer();
      } else {
        return socket.close({ code: 1008, reason: 'Preview network isolation' });
      }
    });
    const page = await context.newPage();
    let pageError = '';
    const onBootError = (error: Error) => { pageError = error.message; };
    page.on('pageerror', onBootError);
    await page.goto(entry, { waitUntil: 'domcontentloaded', timeout: 15000 });
    try { await page.waitForFunction(() => Boolean(window.__prevueWeb), undefined, { timeout: 15000 }); }
    catch { throw new WebError('WEB_BOOT_FAILED', moduleError(bundle.revision()) || pageError || 'The preview browser runtime did not start.'); }
    page.off('pageerror', onBootError);
    return { context, page, pixelRatio, moduleError };
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function verify(reply: ReturnType<BrowserBridge['settle']>, ticket: Ticket) {
  const result = await reply;
  ticket.check();
  if (result.error) throw new WebError(result.error.code, result.error.message);
  const { preview, generation } = ticket.request;
  if (result.commit.previewId !== preview.id || result.commit.generation !== generation || result.commit.revision !== ticket.revision) {
    throw new WebError('WEB_ACK_MISMATCH', 'The browser acknowledged a different preview or generation.');
  }
}

export class WebSession implements PreviewSession {
  readonly id = randomUUID();
  private surface?: Surface;
  private applied?: Ticket;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private target: Ticket,
    private readonly issue: (request: RenderRequest) => Ticket,
    private readonly browser: Browser,
    private readonly bundler: WebBundler,
    private readonly artifacts: string,
  ) {}

  private run<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => {
      if (this.closed) throw new WebError('SESSION_CLOSED', 'The preview session is closed.');
      return action();
    });
    this.queue = result.then(() => {}, () => {});
    return result;
  }

  private async apply(ticket: Ticket): Promise<Page> {
    ticket.check();
    const { width, height, pixelRatio } = dimensions(ticket.request);
    if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1 || !Number.isFinite(pixelRatio) || pixelRatio <= 0) {
      throw new WebError('INVALID_VIEWPORT', 'Width and height must be positive integers and pixelRatio must be positive.');
    }
    const reload = this.bundler.reloadOnChange && this.applied && this.applied.revision !== ticket.revision;
    if (!this.surface || this.surface.pixelRatio !== pixelRatio || reload) {
      await this.surface?.context.close();
      this.applied = undefined;
      this.surface = await surface(this.browser, this.bundler, ticket.request);
      this.surface.page.on('framenavigated', frame => {
        if (frame === this.surface?.page.mainFrame()) this.applied = undefined;
      });
    }
    const { page, moduleError } = this.surface;
    if (this.applied !== ticket) {
      const viewport = page.viewportSize();
      if (viewport?.width !== width || viewport?.height !== height) await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: ticket.request.preview.theme ?? 'light' });
      const request = await this.bundler.request(ticket.request, ticket.revision);
      const applyInBrowser = async () => {
        await page.waitForFunction(() => Boolean(window.__prevueWeb), undefined, { timeout: 15000 });
        try { await verify(page.evaluate(arg => window.__prevueWeb.apply(arg, false), request), ticket); }
        catch (error) {
          if (!(error instanceof WebError) || error.code !== 'WEB_BUNDLE_FAILED') throw error;
          const detail = moduleError(ticket.revision);
          if (!detail) throw error;
          const code = /failed to resolve import ["'](?:react-native[-/]|@react-native[-/])/i.test(detail)
            ? 'WEB_NATIVE_MODULE_UNAVAILABLE' : error.code;
          throw new WebError(code, detail);
        }
      };
      try { await applyInBrowser(); }
      catch (error) {
        // Vite may navigate once when it discovers a new CommonJS dependency.
        if (!(error instanceof Error) || !error.message.includes('Execution context was destroyed')) throw error;
        await applyInBrowser();
      }
      this.applied = ticket;
    } else {
      await verify(page.evaluate(() => window.__prevueWeb.settle()), ticket);
    }
    return page;
  }

  private async readTree(page: Page): Promise<UITree> {
    const inspector = this.bundler.inspector;
    const tree = await page.evaluate(attribute => window.__prevueWeb.tree(attribute), inspector?.attribute);
    return resolveSources(tree, inspector);
  }

  initialize(): Promise<void> {
    return this.run(async () => { await this.apply(this.target); });
  }

  private collect(ticket: Ticket): Promise<RenderResult> {
    const started = performance.now();
    return this.run(async (): Promise<RenderResult> => {
      const page = await this.apply(ticket);
      const tree = await this.readTree(page);
      const image = await page.screenshot({ type: 'png', scale: 'device', timeout: 15000 });
      ticket.check();
      const width = image.readUInt32BE(16);
      const height = image.readUInt32BE(20);
      tree.width = width;
      tree.height = height;
      const prefix = path.join(this.artifacts, randomUUID());
      const imagePath = prefix + '.png';
      const treePath = prefix + '.json';
      await mkdir(this.artifacts, { recursive: true });
      try {
        await writeFile(imagePath, image);
        await writeFile(treePath, JSON.stringify(tree));
        ticket.check();
      } catch (error) {
        await Promise.all([rm(imagePath, { force: true }), rm(treePath, { force: true })]);
        throw error;
      }
      return {
        previewId: ticket.request.preview.id, generation: ticket.request.generation, imageGeneration: ticket.request.generation,
        sessionId: this.id, platform: 'web', status: 'ready', imagePath, treePath, width, height,
        durationMs: Math.round(performance.now() - started), warnings: [],
      };
    }).catch(error => failed(ticket, this.id, started, error));
  }

  capture(): Promise<RenderResult> { return this.collect(this.target); }

  update(request: RenderRequest): Promise<RenderResult> {
    const ticket = this.issue(request);
    if (request.generation >= this.target.request.generation) this.target = ticket;
    return this.collect(ticket);
  }

  inspect(): Promise<UITree> {
    const ticket = this.target;
    return this.run(async () => {
      const page = await this.apply(ticket);
      const tree = await this.readTree(page);
      ticket.check();
      return tree;
    });
  }

  dispatch(input: Interaction): Promise<void> {
    const ticket = this.target;
    return this.run(async () => {
      const page = await this.apply(ticket);
      const { width, height, pixelRatio } = dimensions(ticket.request);
      if (input.type === 'text') {
        await page.keyboard.insertText(input.text);
      } else {
        const x = (input.x ?? width * pixelRatio / 2) / pixelRatio;
        const y = (input.y ?? height * pixelRatio / 2) / pixelRatio;
        await page.mouse.move(x, y);
        switch (input.type) {
          case 'tap': await page.mouse.click(x, y); break;
          case 'press': await page.mouse.down(); break;
          case 'release': await page.mouse.up(); break;
          case 'scroll': await page.mouse.wheel(input.dx / pixelRatio, input.dy / pixelRatio); break;
          case 'drag': break; // mouse.move above retained the button held by press
        }
      }
      ticket.check();
    });
  }

  reset(): Promise<void> {
    const ticket = this.target;
    return this.run(async () => {
      await this.surface?.context.close();
      this.surface = undefined;
      this.applied = undefined;
      await this.apply(ticket);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.queue;
    await this.surface?.context.close();
    this.surface = undefined;
  }
}
