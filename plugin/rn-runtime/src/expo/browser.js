import { inspectDocument } from './tree.js';

let installed;
async function run(action) {
  try {
    return { commit: await action() };
  } catch (error) {
    return { error: { code: 'EXPO_RENDER_FAILED', message: error.message || String(error) } };
  }
}
window.__prevueWeb = {
  apply(request, reset) {
    return run(async () => {
      if (!installed) {
        installed = new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.onload = resolve;
          script.onerror = () => reject(Error('Metro web bundle failed to load'));
          script.src = request.moduleUrl;
          document.head.appendChild(script);
        });
      }
      await installed;
      if (!window.__prevueExpo) throw Error('The Expo preview entry must call registerExpoPreviews');
      return window.__prevueExpo.apply(request, reset);
    });
  },
  settle() {
    return run(() => window.__prevueExpo.settle());
  },
  tree: inspectDocument,
};
