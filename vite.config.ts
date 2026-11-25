import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  worker: { format: 'iife' },
  root: 'client',
  // Tauri expects a fixed port for the dev server
  server: {
    port: 5174,
    strictPort: true,
    // No proxy needed — Tauri uses IPC commands instead of HTTP API
  },
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./client/index.html', import.meta.url)),
        movingPlatform: fileURLToPath(new URL('./client/moving-platform-preview.html', import.meta.url)),
      },
    },
  },
  // Tauri uses `tauri://localhost` as origin in production
  clearScreen: false,
  envPrefix: ['VITE_', 'TAURI_'],
});
