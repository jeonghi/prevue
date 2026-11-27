import type { RenderError, UITree } from '../protocol.ts';

export interface WebRequest {
  previewId: string;
  exportName: string;
  moduleUrl: string;
  providerUrl?: string;
  generation: number;
  revision: number;
}

export interface Commit {
  previewId: string;
  generation: number;
  revision: number;
}

type Reply = { commit: Commit; error?: never } | { commit?: never; error: RenderError };

export interface BrowserBridge {
  apply(request: WebRequest, reset: boolean): Promise<Reply>;
  settle(): Promise<Reply>;
  tree(): UITree;
}

declare global {
  interface Window { __prevueWeb: BrowserBridge }
}

export class WebError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export function describeError(error: unknown): RenderError {
  if (error instanceof WebError) return { code: error.code, message: error.message };
  return { code: 'WEB_RENDER_FAILED', message: error instanceof Error ? error.message : String(error) };
}
