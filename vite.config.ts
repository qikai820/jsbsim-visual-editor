import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
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
  },
  // Tauri uses `tauri://localhost` as origin in production
  clearScreen: false,
  envPrefix: ['VITE_', 'TAURI_'],
});
