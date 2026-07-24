import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'    // ← tailwindcss imported first
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [
    tailwindcss(),    // ← tailwindcss BEFORE react
    react(),
  ],
})
