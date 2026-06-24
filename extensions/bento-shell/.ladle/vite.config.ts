import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, '../../_shared'),
      '@bento': resolve(__dirname, '../src'),
      'react-aria-components': resolve(__dirname, '../../../node_modules/react-aria-components'),
      'react-aria': resolve(__dirname, '../../../node_modules/react-aria'),
      'react-stately': resolve(__dirname, '../../../node_modules/react-stately'),
      '@react-types/shared': resolve(__dirname, '../../../node_modules/@react-types/shared'),
    },
  },

  optimizeDeps: {
    exclude: ['@tale-ui/react', '@tale-ui/react-styles', '@tale-ui/utils'],
  },

  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
});
