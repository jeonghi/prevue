import React, { Component, Fragment, createElement, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';

/** Call from the project's explicit Expo preview entry, with Metro-visible static imports. */
export function registerExpoPreviews(files, GlobalProvider = Fragment) {
  const root = createRoot(document.getElementById('prevue-root'));
  let active,
    pending,
    fault,
    sequence = 0,
    mount = 0;
  class Boundary extends Component {
    state = { failed: false };
    static getDerivedStateFromError() {
      return { failed: true };
    }
    componentDidCatch(error) {
      fault = error;
      pending?.reject(error);
    }
    render() {
      return this.state.failed ? null : this.props.children;
    }
  }
  function Body({ definition }) {
    return definition.render(definition.props ?? {});
  }
  function Ack({ number }) {
    useLayoutEffect(() => {
      if (pending?.number === number) pending.resolve();
    }, [number]);
    return null;
  }
  async function settle() {
    if (fault) throw fault;
    const { definition, request } = active;
    const number = ++sequence,
      Provider = definition.provider ?? Fragment;
    let timer;
    try {
      await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Expo React commit timed out')), 15000);
        pending = { resolve, reject, number };
        root.render(
          createElement(
            Boundary,
            { key: mount },
            createElement(
              GlobalProvider,
              null,
              createElement(Provider, null, createElement(Body, { definition }))
            ),
            createElement(Ack, { number })
          )
        );
      });
    } finally {
      clearTimeout(timer);
      pending = undefined;
    }
    await document.fonts.ready;
    await Promise.all(Array.from(document.images, (img) => img.decode()));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (fault) throw fault;
    return { previewId: request.previewId, generation: request.generation, revision: request.revision };
  }
  window.__prevueExpo = {
    async apply(request, reset) {
      const file = new URL(request.moduleUrl, location.href).searchParams.get('file');
      const definition = files[file]?.[request.exportName];
      if (!definition || typeof definition.render !== 'function')
        throw Error('Register ' + file + '#' + request.exportName + ' in the Expo preview entry');
      if (reset || fault || active?.request.previewId !== request.previewId) mount++;
      fault = undefined;
      active = { definition, request };
      return settle();
    },
    settle,
  };
}
