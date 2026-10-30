/** Replaced by Vite. Independent of import.meta.env.DEV in packaged browser shells. */
declare const __BENTO_SOFTCAST_DEMO__: boolean;

declare module '*scripts/build-mode.mjs' {
  export function isReleaseBuild(root: string, env?: Record<string, string | undefined>): boolean;
}
