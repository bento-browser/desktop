import type { Alias, Plugin, UserConfig } from 'vite';

export interface MuxLocal {
  /** Absolute path of the local Mux `packages/react` directory. */
  root: string;
  /** Exact-match aliases, one per public export. */
  aliases: Alias[];
  /** Absolute declaration file per public specifier that ships types. */
  types: Record<string, string>;
}

export function resolveMuxLocal(env?: NodeJS.ProcessEnv): MuxLocal | undefined;
export function muxLocalViteConfig(mux: MuxLocal | undefined, workspaceRoot: string): UserConfig;
export function muxSourcePlugin(mux: MuxLocal | undefined, npmPackageJson: string): Plugin;
