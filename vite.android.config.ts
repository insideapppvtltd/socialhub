import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: resolve(root, 'src/renderer'),
  envDir: root,
  plugins: [react()],
  resolve: {
    alias: {
      '@renderer': resolve(root, 'src/renderer')
    }
  },
  build: {
    outDir: resolve(root, 'dist-android'),
    emptyOutDir: true
  }
})
