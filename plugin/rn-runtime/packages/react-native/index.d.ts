import type { ComponentType, PropsWithChildren, ReactNode } from 'react';

export type PreviewPlatform = 'web' | 'ios' | 'android';
export type PreviewTheme = 'light' | 'dark';
export type PreviewProvider = ComponentType<PropsWithChildren>;

export interface PreviewDefinition<Props extends object = Record<string, never>> {
  name?: string;
  render: (props: Props) => ReactNode;
  props?: Props;
  /** Mounted inside the default provider from the project's prevue.providers.tsx. */
  provider?: PreviewProvider;
  viewport?: { width: number; height: number; pixelRatio?: number };
  theme?: PreviewTheme;
  platforms?: readonly PreviewPlatform[];
}

export function definePreview<Props extends object = Record<string, never>>(
  definition: PreviewDefinition<Props>,
): PreviewDefinition<Props>;
