import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, extname } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const production = process.argv.includes('--production');
const vite = production ? null : await (await import('vite')).createServer({
  configFile: join(root, 'vite.config.ts'), server: { middlewareMode: true }, appType: 'custom',
});
const renderProduction = production ? (await import('./dist/server/entry-server.js')).render : null;
const productionTemplate = production ? await readFile(join(root, 'dist/client/index.html'), 'utf8') : null;
const mime = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const server = createHttpServer((req, res) => {
  const handle = async () => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (production && url.pathname.startsWith('/assets/')) {
        // Vite outputs flat, hashed filenames. Do not accept arbitrary file paths.
        if (!/^\/assets\/[A-Za-z0-9_.-]+$/.test(url.pathname)) { res.writeHead(404).end(); return; }
        try {
          const asset = await readFile(join(root, 'dist/client', url.pathname));
          res.writeHead(200, { 'Content-Type': mime[extname(url.pathname)] ?? 'application/octet-stream', 'Cache-Control': 'public, max-age=31536000, immutable' }).end(asset);
        } catch { res.writeHead(404).end(); }
        return;
      }
      if (url.pathname !== '/') { res.writeHead(404).end(); return; }
      const template = productionTemplate ?? await vite.transformIndexHtml(req.url, await readFile(join(root, 'index.html'), 'utf8'));
      const render = renderProduction ?? (await vite.ssrLoadModule('/src/entry-server.tsx')).render;
      const result = await render(url.searchParams.get('lang'));
      const html = template.replace('<!--locale-->', () => result.locale)
        .replace('<!--direction-->', () => result.direction)
        .replace('<!--app-html-->', () => result.html)
        .replace('<!--initial-data-->', () => result.data);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Language': result.locale, 'Cache-Control': 'no-store' }).end(html);
    } catch (error) {
      vite?.ssrFixStacktrace(error);
      console.error(error);
      res.writeHead(500).end('Unable to render this page.');
    }
  };
  if (vite) vite.middlewares(req, res, () => void handle()); else void handle();
});
const port = Number(process.env.PORT ?? 5174);
server.listen(port, '127.0.0.1', () => console.log(`React SSR example: http://127.0.0.1:${server.address().port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  server.close();
  void vite?.close();
});
