import React, { Component, Fragment, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
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

function storyDefinition(module, exportName) {
  const meta = module.default;
  const story = module[exportName];
  if (!meta || !story) throw fault('INVALID_STORY', 'CSF needs default meta and a named story');
  const supportedMeta = ['title', 'id', 'component', 'args', 'render'];
  const supportedStory = ['name', 'args', 'render'];
  for (const [annotations, supported] of [[meta, supportedMeta], [story, supportedStory]]) {
    const key = Object.keys(annotations).find(name => !supported.includes(name));
    if (key) throw fault('UNSUPPORTED_STORY', 'Unsupported CSF annotation: ' + key);
  }
  const args = { ...meta.args, ...story.args };
  const render = (typeof story === 'function' ? story : story.render) ?? meta.render;
  if (render?.length > 1) throw fault('UNSUPPORTED_STORY', 'CSF render context is unavailable');
  if (!render && !meta.component) throw fault('INVALID_STORY', 'CSF needs either a render function or meta.component');
  return { props: args, render: render ?? (props => React.createElement(meta.component, props)) };
}

async function apply(request, reset) {
  if (reset || lastError || request.previewId !== current?.request.previewId) mount++;
  lastError = undefined;
  let module, providers;
  try {
    [module, providers] = await deadline(Promise.all([
      import(/* @vite-ignore */ request.moduleUrl),
      request.providerUrl ? import(/* @vite-ignore */ request.providerUrl) : undefined,
    ]), 'Loading the preview module timed out.');
  } catch (error) {
    throw fault('WEB_BUNDLE_FAILED', error.message);
  }
  const definition = request.format === 'csf' ? storyDefinition(module, request.exportName) : module[request.exportName];
  if (!definition || typeof definition.render !== 'function') {
    throw fault('INVALID_PREVIEW', 'Export ' + request.exportName + ' has no render function.');
  }
  if (providers && !providers.default) throw fault('INVALID_PREVIEW_PROVIDER', 'prevue.providers.tsx must have a default export.');
  await waitForRevision(request.revision);
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
