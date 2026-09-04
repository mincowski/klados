import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [react()],
    // parse.worker.ts is instantiated as `new Worker(url, { type: 'module' })`
    // (B11) and itself uses `import` — the build's worker output must be ES
    // modules, not Vite's default IIFE, or the built app's worker fails to
    // load with a syntax error under `import`.
    worker: {
      format: 'es'
    }
  }
})
