import type { IncomingMessage, ServerResponse } from 'node:http';

export type Platform = 'web' | 'ios' | 'android';
export type Viewport = { width: number; height: number; pixelRatio?: number };
export type Source = { file: string; line: number; column?: number };

export interface PreviewDescriptor {
  id: string;
  framework: 'react-native' | 'compose';
  format?: 'csf';
  source: Source & { exportName: string };
  name: string;
  platforms: Platform[];
  viewport?: Viewport;
  theme?: 'light' | 'dark';
}

export interface Capabilities {
  screenshot: boolean;
  interactiveInput: boolean;
  uiTree: boolean;
  sourceLocation: boolean;
  viewportResize: boolean;
  themeOverride: boolean;
  nativeInsets: boolean;
  animationFrameControl: boolean;
  stateReset: boolean;
}

export interface UINode {
  id: string;
  name: string;
  bounds: { x: number; y: number; width: number; height: number };
  source?: Source | null;
  text?: string;
  accessibilityRole?: string;
  accessibilityLabel?: string;
  testId?: string;
  children: UINode[];
}
export type UITree = { width: number; height: number; nodes: UINode[] };

export type Interaction =
  | { type: 'tap' | 'press' | 'drag' | 'release'; x: number; y: number }
  | { type: 'scroll'; x?: number; y?: number; dx: number; dy: number }
  | { type: 'text'; text: string };

export type RenderError = { code: string; message: string };
export interface RenderResult {
  previewId: string;
  sessionId: string;
  generation: number;
  platform: Platform;
  status: 'ready' | 'error' | 'stale';
  // If stale, imageGeneration identifies the last successful render.
  imageGeneration?: number;
  imagePath?: string;
  treePath?: string;
  width: number;
  height: number;
  durationMs: number;
  warnings: string[];
  error?: RenderError;
}

export interface RenderRequest {
  preview: PreviewDescriptor;
  generation: number;
}
export interface ProjectContext {
  root: string;
  artifacts: string;
  platform: Platform;
  device?: string;
  // Absolute path after the bundler has invalidated this source.
  changed(file: string): void;
}
export interface PreviewSession {
  id: string;
  capture(): Promise<RenderResult>;
  update(request: RenderRequest): Promise<RenderResult>;
  inspect(): Promise<UITree>;
  dispatch(input: Interaction): Promise<void>;
  reset(): Promise<void>;
  close(): Promise<void>;
}
export interface PreviewRenderer {
  capabilities(): Capabilities;
  prepare(context: ProjectContext): Promise<void>;
  render(request: RenderRequest): Promise<RenderResult>;
  openSession(request: RenderRequest): Promise<PreviewSession>;
  dispose(): Promise<void>;
}

export interface Snapshot {
  projectRoot: string;
  version: number;
  generation: number;
  platform: Platform;
  capabilities: Capabilities;
  previews: PreviewDescriptor[];
  results: Record<string, RenderResult>;
  tabs: string[];
  activeFile: string | null;
  focusId: string | null;
  boardFocusId?: string;
  interactive: boolean;
  busy: boolean;
  error: RenderError | null;
  selection: UINode | null;
  selectionPreviewId?: string;
}
export interface ViewerHost {
  snapshot(): Snapshot;
  subscribe(listener: () => void): () => void;
  execute(command: string, args: Record<string, unknown>): Promise<unknown>;
  artifactUrl(file: string): string;
}
export type ViewerRoute = (req: IncomingMessage, res: ServerResponse, url: URL, host: ViewerHost) => Promise<boolean>;
