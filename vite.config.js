import { defineConfig } from 'vite';

// Cargo Chaos build config.
// rapier3d-compat inlines its WASM as base64, so no special wasm plugin is needed.
export default defineConfig({
  base: './',
  server: {
    host: true,
    open: true,
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
  },
});
