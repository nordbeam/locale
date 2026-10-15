import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { nordbeamLocale } from '@nordbeam/locale/vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [nordbeamLocale({ baseLocale: 'en', timeZone: 'UTC' })],
});
