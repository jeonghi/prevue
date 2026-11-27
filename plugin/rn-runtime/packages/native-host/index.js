import { Component, Fragment, createElement, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AppState, DevSettings, Dimensions, Platform, Text, View } from 'react-native';

export function createPreviewHost({ registry, provider = Fragment, revision, endpoint, token }) {
  if (!__DEV__) throw new Error('Prevue native hosts require a debug build.');
  const headers = { authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  async function acknowledge(command, error) {
    const { width, height, scale } = Dimensions.get('screen');
    const { id, sessionId, previewId, generation } = command;
    await fetch(endpoint + '/ack', {
      method: 'POST', headers,
      body: JSON.stringify({ id, sessionId, previewId, generation, revision, platform: Platform.OS, screen: { width, height, scale },
        error: error || (AppState.currentState === 'background' ? 'Debug host is in the background.' : undefined) }),
    });
  }

  class Boundary extends Component {
    state = { error: null };
    static getDerivedStateFromError(error) { return { error: String(error) }; }
    componentDidCatch(error) { void acknowledge(this.props.command, String(error)).catch(() => {}); }
    render() { return this.state.error ? createElement(Text, { accessibilityRole: 'alert' }, this.state.error) : this.props.children; }
  }

  function CommittedPreview({ command, reportRef }) {
    const nativeView = useRef(null);
    useLayoutEffect(() => {
      let mounted = true;
      const frame = requestAnimationFrame(() => {
        // Fabric's measure callback crosses the native mount boundary for this exact commit.
        nativeView.current?.measureInWindow(() => {
          requestAnimationFrame(() => { if (mounted) void acknowledge(command).catch(() => {}); });
        });
      });
      return () => { mounted = false; cancelAnimationFrame(frame); };
    }, [command.id]);
    let child = null;
    if (command.action !== 'close') {
      const definition = registry[command.previewId]?.();
      if (!definition || typeof definition.render !== 'function') throw new Error('Unknown native preview ' + command.previewId);
      const props = { ...definition.props, ...reportRef.current };
      child = createElement(provider, null, createElement(definition.provider ?? Fragment, null, createElement(definition.render, props)));
    }
    return createElement(View, { ref: nativeView, collapsable: false, style: { flex: 1 } }, child);
  }

  return function PreviewHost() {
    const [state, setState] = useState(null);
    const args = useRef({});
    useEffect(() => {
      const controller = new AbortController();
      let after = '';
      async function listen() {
        while (!controller.signal.aborted) {
          try {
            const url = endpoint + '/next?revision=' + encodeURIComponent(revision) + '&after=' + encodeURIComponent(after);
            const reply = await fetch(url, { headers, signal: controller.signal });
            if (reply.status === 204) continue;
            if (!reply.ok) throw new Error('Native preview bridge returned HTTP ' + reply.status);
            const command = await reply.json();
            if (controller.signal.aborted) return;
            if (command.action === 'reload') { DevSettings.reload(); return; }
            if (command.revision !== revision || command.id === after) continue;
            after = command.id;
            if (command.action === 'open' || command.action === 'reset') args.current = {};
            if (command.action === 'args') args.current = command.args ?? {};
            setState(previous => ({
              command,
              key: ['open', 'reset', 'close'].includes(command.action) || !previous ? command.id : previous.key,
            }));
          } catch {
            if (!controller.signal.aborted) await new Promise(resolve => setTimeout(resolve, 500));
          }
        }
      }
      void listen();
      return () => controller.abort();
    }, []);
    if (!state) return createElement(View, { style: { flex: 1 } }, createElement(Text, null, 'Waiting for Prevue'));
    return createElement(Boundary, { key: state.key, command: state.command },
      createElement(CommittedPreview, { command: state.command, reportRef: args }));
  };
}
