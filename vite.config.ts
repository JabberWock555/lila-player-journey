import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Deployed as a GitHub Pages *project* site, so assets live under /<repo>/.
// BASE_PATH is set by the deploy workflow; local dev and other hosts use '/'.
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [react()],
  build: { target: 'es2020', assetsInlineLimit: 0 },
})
