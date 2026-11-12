import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// O daemon serve o front buildado na mesma porta (4317). Em dev, o Vite sobe
// separado e encaminha API e WebSocket pro daemon, pra não duplicar origem.
const DAEMON = 'http://127.0.0.1:4317'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist/front',
    emptyOutDir: true,
  },
  server: {
    port: 4316,
    strictPort: true,
    proxy: {
      '/api': DAEMON,
      '/hooks': DAEMON,
      '/mcp': DAEMON,
      '/ws': { target: DAEMON, ws: true },
    },
  },
})
