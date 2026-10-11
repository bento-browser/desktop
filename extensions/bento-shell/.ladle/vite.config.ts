import { defineConfig, mergeConfig, searchForWorkspaceRoot } from 'vite';
import { resolve } from 'node:path';
import { muxLocalViteConfig, resolveMuxLocal } from '../muxui-local.mjs';

// With MUXUI_LOCAL set (local Mux development only) the fragment aliases
// @muxui/react to the local Mux checkout; otherwise it is empty. The React Aria
// aliases below stay so Mux and Bento share one React Aria identity.
export default defineConfig(
  mergeConfig(
    {
      resolve: {
        alias: [
          { find: '@shared', replacement: resolve(__dirname, '../../_shared') },
          { find: '@bento', replacement: resolve(__dirname, '../src') },
          {
            find: 'react-aria-components',
            replacement: resolve(__dirname, '../../../node_modules/react-aria-components'),
          },
          {
            find: 'react-aria',
            replacement: resolve(__dirname, '../../../node_modules/react-aria'),
          },
          {
            find: 'react-stately',
            replacement: resolve(__dirname, '../../../node_modules/react-stately'),
          },
          {
            find: '@react-types/shared',
            replacement: resolve(__dirname, '../../../node_modules/@react-types/shared'),
          },
        ],
      },

      define: {
        'process.env.NODE_ENV': JSON.stringify('production'),
      },
    },
    muxLocalViteConfig(resolveMuxLocal(), searchForWorkspaceRoot(resolve(__dirname, '..'))),
  ),
);
