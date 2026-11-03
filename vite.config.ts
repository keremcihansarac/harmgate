import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src',
  publicDir: resolve(__dirname, 'public'),
  base: '',
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    modulePreload: false,
    target: 'chrome121',
    rollupOptions: {
      input: {
        background: resolve(__dirname, 'src/background.ts'),
        block: resolve(__dirname, 'src/block.html'),
        options: resolve(__dirname, 'src/options.html'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
