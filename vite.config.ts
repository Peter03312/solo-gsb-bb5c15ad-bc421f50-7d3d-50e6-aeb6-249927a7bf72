import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
  preview: {
    host: '0.0.0.0',
    port: 5173,
  },
  // 规划计算运行于 Web Worker（src/workers/planner.worker.ts），由 Vite 一并打包为独立 chunk
  worker: {
    format: 'es',
  },
})
