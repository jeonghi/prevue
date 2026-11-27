import { chromium, type Browser } from 'playwright';
import type { PreviewRenderer, ProjectContext, RenderRequest } from '../protocol.ts';
import { WebError } from './bridge.ts';
import { startBundler, type WebBundler } from './bundler.ts';
import { WebSession, type Ticket } from './session.ts';

export function createWebRenderer(makeBundler: (context: ProjectContext) => Promise<WebBundler> = startBundler): PreviewRenderer {
  let bundle: WebBundler | undefined;
  let browser: Browser | undefined;
  let project: ProjectContext | undefined;
  let generation = -1;
  let sourceRevision = -1;
  const slots: Promise<void>[] = [Promise.resolve(), Promise.resolve()];
  let nextSlot = 0;

  function issue(request: RenderRequest): Ticket {
    if (!bundle || !browser || !project) throw new WebError('WEB_NOT_PREPARED', 'Prepare the web renderer first.');
    const server = bundle;
    if (request.generation > generation) {
      generation = request.generation;
      sourceRevision = server.revision();
    }
    const revision = sourceRevision;
    return {
      request, revision,
      check() {
        if (bundle !== server || generation !== request.generation || revision !== server.revision()) {
          throw new WebError('STALE_GENERATION', 'A newer source generation superseded this render.');
        }
        if (!request.preview.platforms.includes('web')) throw new WebError('UNSUPPORTED_PLATFORM', 'This preview does not support web.');
      },
    };
  }

  function session(request: RenderRequest) {
    const ticket = issue(request);
    return new WebSession(ticket, issue, browser!, bundle!, project!.artifacts);
  }

  async function dispose() {
    const server = bundle;
    const process = browser;
    bundle = undefined;
    browser = undefined;
    project = undefined;
    generation = -1;
    try { await process?.close(); }
    finally { await server?.close(); }
  }

  return {
    capabilities: () => ({
      screenshot: true, interactiveInput: true, uiTree: true, sourceLocation: makeBundler === startBundler,
      viewportResize: false, themeOverride: false, nativeInsets: false, animationFrameControl: false, stateReset: true,
    }),
    async prepare(context) {
      if (context.platform !== 'web') throw new WebError('UNSUPPORTED_PLATFORM', 'The web renderer requires platform web.');
      if (bundle) await dispose();
      bundle = await makeBundler(context);
      try { browser = await chromium.launch(); }
      catch (error) {
        await dispose();
        throw new WebError('WEB_BROWSER_UNAVAILABLE', 'Playwright Chromium could not start. Run playwright install chromium. ' + String(error));
      }
      project = context;
    },
    render(request) {
      const shot = session(request);
      const slot = nextSlot++ % slots.length;
      const result = slots[slot].then(() => shot.capture()).finally(() => shot.close());
      slots[slot] = result.then(() => {}, () => {});
      return result;
    },
    async openSession(request) {
      const live = session(request);
      try { await live.initialize(); return live; }
      catch (error) { await live.close(); throw error; }
    },
    dispose,
  };
}
