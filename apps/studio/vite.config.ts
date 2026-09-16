import { defineConfig } from 'vite'
import { studioApiPlugin } from './src/server.js'

export default defineConfig({
  plugins: [studioApiPlugin()],
  server: {
    port: 5177,
  },
})
