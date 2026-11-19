import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnv } from 'vite'

const root = dirname(fileURLToPath(import.meta.url))

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, '')
  return {
    main: {
      define: {
        'process.env.VITE_GOOGLE_OAUTH_CLIENT_ID': JSON.stringify(env.VITE_GOOGLE_OAUTH_CLIENT_ID ?? ''),
        'process.env.GOOGLE_OAUTH_CLIENT_SECRET': JSON.stringify(env.GOOGLE_OAUTH_CLIENT_SECRET ?? env.GOOGLE_CLIENT_SECRET ?? '')
      },
      plugins: [externalizeDepsPlugin()],
      build: {
        rollupOptions: {
          input: {
            index: resolve(root, 'src/main/index.ts')
          }
        }
      }
    },
    preload: {
      plugins: [externalizeDepsPlugin()],
      build: {
        rollupOptions: {
          output: {
            format: 'cjs',
            entryFileNames: '[name].cjs'
          },
          input: {
            index: resolve(root, 'src/preload/index.ts'),
            site: resolve(root, 'src/preload/site.ts')
          }
        }
      }
    },
    renderer: {
      resolve: {
        alias: {
          '@renderer': resolve(root, 'src/renderer')
        }
      },
      plugins: [react()]
    }
  }
})
