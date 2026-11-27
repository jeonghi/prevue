import type { RenderError } from './protocol.ts';

export class PreviewFailure extends Error {
  constructor(readonly code: string, message: string, readonly exitCode = 1) { super(message); }
}
export function errorInfo(error: unknown): RenderError {
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code : 'RUNTIME_FAILED';
  return { code, message: error instanceof Error ? error.message : String(error) };
}
export function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new PreviewFailure('USAGE', label + ' is required', 2);
  return value;
}
export function numberArg(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new PreviewFailure('USAGE', label + ' must be a finite number', 2);
  return value;
}
