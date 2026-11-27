import type { ComponentType, PropsWithChildren } from 'react';

/** Each key is the project-relative filename of a statically imported module. */
export function registerExpoPreviews(
  files: Record<string, Record<string, unknown>>,
  provider?: ComponentType<PropsWithChildren>
): void;
