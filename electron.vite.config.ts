import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: 'src/preload/index.ts', 'host-file-preview': 'src/preload/host-file-preview.ts' },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    build: { rollupOptions: { input: { index: 'src/renderer/index.html', 'host-file-preview': 'src/renderer/host-file-preview.html' } } }
  }
});
