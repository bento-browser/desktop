import type { Alias, Plugin, UserConfig } from 'vite';

export const MUX_PACKAGE: '@muxui/react';
export const MUX_SOURCE_STAMP: 'muxui-source.json';

export interface MuxLocal {
  /** Absolute path of the local Mux `packages/react` directory. */
  root: string;
  /** Exact-match aliases, one per public export. */
  aliases: Alias[];
  /** Absolute declaration file per public specifier that ships types. */
  types: Record<string, string>;
}

export function isReleaseBuild(env?: NodeJS.ProcessEnv): boolean;
export function muxLocalRoot(env?: NodeJS.ProcessEnv): string | undefined;
export function resolveMuxLocal(env?: NodeJS.ProcessEnv): MuxLocal | undefined;
export function muxLocalViteConfig(mux: MuxLocal | undefined, workspaceRoot: string): UserConfig;
export function muxSourcePlugin(mux: MuxLocal | undefined, npmPackageJson: string): Plugin;
export function rollbackMuxStamp(variant: string): { source: 'rollback'; variant: string };
export function assertMuxSourceStamp(
  text: string | undefined,
  options: { where: string; variant: string | undefined; variants: readonly string[] },
): void;
export function muxLocalTsconfig(mux: MuxLocal): {
  extends: string;
  compilerOptions: { paths: Record<string, string[]> };
};
