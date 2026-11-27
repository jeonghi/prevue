import React, { Component, Fragment, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { getRefreshReg } from '/@react-refresh';
import { Revision } from './revision.jsx';
import { inspectDocument } from './tree.js';

const root = createRoot(document.getElementById('prevue-root'));
let appliedRevision = -1;
let notifyRevision;
let current;
let mount = 0;
let sequence = 0;
let lastError;
let pending;

function fault(code, message) {
  return Object.assign(new Error(message), { code });
}

function deadline(promise, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(fault('WEB_COMMIT_TIMEOUT', message)), 15000); }),
  ]).finally(() => clearTimeout(timer));
}

function reportRevision(value) {
  appliedRevision = value;
  notifyRevision?.();
}

async function waitForRevision(target) {
  try {
    if (appliedRevision < target) {
      await deadline(new Promise(resolve => {
        notifyRevision = () => { if (appliedRevision >= target) resolve(); };
      }), 'React Fast Refresh did not commit the requested source revision.');
    }
    if (appliedRevision !== target) throw fault('STALE_GENERATION', 'A newer source revision reached this page.');
  } finally {
    notifyRevision = undefined;
  }
}

function rememberError(error) {
  lastError = error instanceof Error ? error : new Error(String(error));
  pending?.reject(lastError);
}

class Boundary extends Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error) { rememberError(error); }
  render() { return this.state.failed ? null : this.props.children; }
}

// Keep the React component that owns render() hooks stable across a descriptor reload.
function PreviewBody({ definition }) {
  return definition.render(definition.props ?? {});
}

function Committed({ command }) {
  useLayoutEffect(() => {
    if (command === pending?.command) pending.resolve();
  }, [command]);
  return null;
}

function renderScreen(command) {
  let scene = null;
  if (current) {
    const { definition, GlobalProvider } = current;
    const Provider = definition.provider ?? Fragment;
    scene = <Boundary key={mount}><GlobalProvider><Provider><PreviewBody definition={definition} /></Provider></GlobalProvider><Committed command={command} /></Boundary>;
  }
  root.render(<><Revision report={reportRevision} />{scene}</>);
}

async function commit() {
  if (lastError) throw lastError;
  const command = ++sequence;
  try {
    await deadline(new Promise((resolve, reject) => {
      pending = { command, resolve, reject };
      renderScreen(command);
    }), 'The preview did not commit its React tree.');
  } finally {
    pending = undefined;
  }
  const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
  await deadline((async () => {
    await frame();
    await Promise.all([
      document.fonts.ready,
      ...Array.from(document.images).filter(image => image.currentSrc || image.src)
        .map(image => image.decode().catch(() => { throw fault('WEB_ASSET_FAILED', 'Could not load image ' + image.src); })),
    ]);
    await frame();
  })(), 'The preview did not finish laying out its assets.');
  if (lastError) throw lastError;
  const { previewId, generation, revision } = current.request;
  if (appliedRevision !== revision) throw fault('STALE_GENERATION', 'The preview changed before capture.');
  return { previewId, generation, revision };
}

async function reply(operation) {
  try {
    return { commit: await operation() };
  } catch (error) {
    return { error: { code: error.code || 'WEB_RENDER_FAILED', message: error.message || String(error) } };
  }
}

async function apply(request, reset) {
  if (reset || lastError || request.previewId !== current?.request.previewId) mount++;
  lastError = undefined;
  // Vite's accept callbacks register the new provider families before React
  // commits the revision marker. Preserve that ordering for the live tree.
  await waitForRevision(request.revision);
  let module, providers;
  try {
    // Import the exact HMR URL. Vite adds ?import to a dynamic relative URL,
    // which would evaluate a second instance of this module and its providers.
    [module, providers] = await deadline(Promise.all([
      import(/* @vite-ignore */ new URL(request.moduleUrl, location.href).href),
      request.providerUrl ? import(/* @vite-ignore */ new URL(request.providerUrl, location.href).href) : undefined,
    ]), 'Loading the preview module timed out.');
  } catch (error) {
    throw fault('WEB_BUNDLE_FAILED', error.message);
  }
  const definition = module[request.exportName];
  if (!definition || typeof definition.render !== 'function') {
    throw fault('INVALID_PREVIEW', 'Export ' + request.exportName + ' has no render function.');
  }
  if (definition.provider) {
    getRefreshReg(new URL(request.moduleUrl, location.href).pathname)(definition.provider, request.exportName + '.provider');
  }
  if (providers && !providers.default) throw fault('INVALID_PREVIEW_PROVIDER', 'prevue.providers.tsx must have a default export.');
  current = { request, definition, GlobalProvider: providers?.default ?? Fragment };
  return commit();
}

window.addEventListener('error', event => { if (event.error) rememberError(event.error); });
window.addEventListener('unhandledrejection', event => rememberError(event.reason));
window.__prevueWeb = {
  apply: (request, reset) => reply(() => apply(request, reset)),
  settle: () => reply(commit),
  tree: inspectDocument,
};
renderScreen(0);
