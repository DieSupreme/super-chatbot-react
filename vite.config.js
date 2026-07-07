// Vite build config for the Electron renderer.
// base './' makes asset URLs relative, which is required because Electron
// loads dist/index.html over file:// (absolute /assets/... paths would 404).
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // one JS + one CSS file keeps the packaged app simple to inspect.
    // node-pty is a native, main-process-only module — never let it into the
    // renderer bundle (the renderer never imports it, this is belt-and-suspenders).
    rollupOptions: { external: ['node-pty'], output: { manualChunks: undefined } }
  }
});
