# React Native preview protocol

The typed boundary lives in `plugin/rn-runtime/src/protocol.ts`. Descriptor paths, tab keys and activeFile are relative to the canonical project root. Lines and columns are one-based. IDs derive from path and export. Screenshot coordinates and tree bounds use image pixels. An image URL identifies immutable bytes, including captures from different interactions in the same source generation.

The viewer receives the same initial state shape as the Compose fixtures and full snapshots over SSE in `{"type":"state","state":…}` envelopes. Browser intents use JSON POST. GET /viewer/state, /events, /project-files.json, /preview-files.json, /gallery/card and /stream, and POST /stream/viewport are defined by BrowserEndpoint and viewer-src/src/runtime/api.ts. The viewer protocol version counter orders UI updates independently of render generations. The RN snapshot also carries platform, capabilities, errors and freshness.

The renderer reports source invalidation after bundler invalidation, returns images only after runtime commit, and uses an isolated session for interactive input. A stale result retains imageGeneration and cannot satisfy a successful wait. Unsupported operations return explicit errors.

## Actual transports

| Caller | Request | Result |
| --- | --- | --- |
| Browser | GET /events | Full state on attach and ordered state updates; the view ignores older versions |
| Browser | GET /preview-files.json, /project-files.json, /gallery/card?file=… | Search index, source index and up to three gallery thumbnails |
| Browser | POST /viewer/open, /viewer/focus, /viewer/exit, /viewer/tab, /viewer/close | Project-relative tab or zero-based preview index |
| Browser | POST /viewer/touch, /viewer/wheel, /viewer/type | Input routed to the current interactive session |
| Browser | GET /stream; POST /stream/viewport | Confirmed frames as multipart images, plus a viewer width hint |
| Browser | POST /viewer/point | Current tree URL and element ID. A superseded tree is rejected |
| CLI | POST /command/{command} | JSON response; a failed capture carries the error and the last good image generation when available |

The CLI authenticates with the worktree session secret. Its private viewer link exchanges the secret for an HttpOnly, SameSite cookie and redirects to a clean URL. The server binds to 127.0.0.1, checks the Host and Origin, and maps opaque capture IDs to known files. Browser requests cannot invoke the CLI shutdown endpoint.

The Vite adapter marks the applied module revision and waits for a React commit, layout, fonts and images. It rechecks the revision before publishing. Source edits (including shared modules) advance generation. Touches produce new immutable PNG and tree paths within the same generation. The session manager publishes a new version for each visible update.

A UI node contains its screenshot-pixel bounds, optional role, label, text and test ID. Web source locations are one-based and project-relative. For example, use `prevue rn focus 0 --on` to get a tree, aim at a node via `prevue rn point <x> <y>`, then read `prevue rn selection`. A node with a null source still has measured bounds.
