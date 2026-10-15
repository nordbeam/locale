import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { nordbeamLocale } from '@nordbeam/locale/vite';

export default defineConfig(({ isSsrBuild }) => ({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [nordbeamLocale({ baseLocale: 'en', catalogs: '../vite/messages', timeZone: 'UTC' })],
  build: { outDir: isSsrBuild ? 'dist/server' : 'dist/client' },
}));
