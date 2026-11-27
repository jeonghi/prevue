# Delivery order

| Branch | Base | Acceptance |
| --- | --- | --- |
| feat/rn-foundation | main | Upstream baseline, viewer and renderer contracts |
| feat/rn-core | foundation | Discovery, SDK, project isolation, CLI and fixture |
| feat/rn-web-renderer | core | Actual RN Web screenshots, input and commit acknowledgement |
| feat/rn-viewer | core | Existing board, gallery, focus and file search |
| feat/rn-inspector | web renderer | Source-instrumented bounds, selection and agent loop |
| feat/rn-native-renderer | core | Debug host, generation ACK, explicit device and lease |
| feat/rn-integration | combined feature branches | End-to-end tests, packaging, benchmarks and demo |
| feat/rn-brownfield | integrated native path | Explicit debug-only embedding and compatibility tests |

The first demonstration uses Default, Loading and Error from OrderCard.preview.tsx, followed by an edit to the shared padding and a new capture. Native results require a device capture. Missing tools or host integration are recorded independently per platform.
