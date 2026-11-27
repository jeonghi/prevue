# React Native preview protocol

The typed boundary lives in `plugin/rn-runtime/src/protocol.ts`. Descriptor paths, tab keys and activeFile are relative to the canonical project root. Lines and columns are one-based. IDs derive from path and export. Screenshot coordinates and tree bounds use image pixels. An image URL identifies immutable bytes, including captures from different interactions in the same source generation.

The viewer receives the same initial state shape as the Compose fixtures and full snapshots over SSE in `{"type":"state","state":…}` envelopes. Browser intents use JSON POST. GET /viewer/state, /events, /project-files.json, /preview-files.json, /gallery/card and /stream, and POST /stream/viewport are defined by BrowserEndpoint and viewer-src/src/runtime/api.ts. The viewer protocol version counter orders UI updates independently of render generations. The RN snapshot also carries platform, capabilities, errors and freshness.

The renderer reports source invalidation after bundler invalidation, returns images only after runtime commit, and uses an isolated session for interactive input. A stale result retains imageGeneration and cannot satisfy a successful wait. Unsupported operations return explicit errors.
