import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// A static, fully client-side page: `pnpm --filter @longhand/verifier web:build`
// writes plain files to web/dist that any static host can serve.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  plugins: [react()],
  // One self-contained page; the fold and its dependencies make it ~0.5 MB.
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  server: { port: Number(process.env.VERIFIER_PORT ?? 4391), strictPort: true },
  preview: { port: Number(process.env.VERIFIER_PORT ?? 4391), strictPort: true },
});
