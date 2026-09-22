import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { loadEnv } from 'vite'

const accountEnv = loadEnv(process.env.NODE_ENV || 'production', process.cwd(), 'VITE_')

export default defineConfig({
  main: {
    define: {
      __PARITY_SUPABASE_URL__: JSON.stringify(accountEnv.VITE_SUPABASE_URL || ''),
      __PARITY_SUPABASE_KEY__: JSON.stringify(accountEnv.VITE_SUPABASE_ANON_KEY || ''),
    },
    plugins: [externalizeDepsPlugin({ exclude: ['pixelmatch'] })],
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts'), 'automation-worker': resolve('src/main/automation/worker.ts') },
        output: { entryFileNames: '[name].js' }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer/src')
      }
    },
    plugins: [react()]
  }
})
