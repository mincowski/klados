import { defineConfig } from 'vite';

/**
 * Builds each renderer entry into its own CommonJS file so it can run inside
 * an Electron renderer with nodeIntegration (where `require` and `module`
 * exist). Node builtins and `electron` stay external — provided by the host.
 */
export default defineConfig({
  build: {
    lib: {
      entry: {
        renderer: 'renderer.js',
        'renderer-windowed': 'renderer-windowed.js',
        'renderer-a6b': 'renderer-a6b.js',
        'renderer-d15-open': 'renderer-d15-open.js',
        'renderer-d15-scroll': 'renderer-d15-scroll.js',
      },
      formats: ['cjs'],
      fileName: (_format, entryName) => `${entryName}.cjs`,
    },
    rollupOptions: {
      external: ['fs', 'path', 'electron', 'process'],
    },
    minify: false,
    target: 'chrome120',
    emptyOutDir: true,
  },
});
