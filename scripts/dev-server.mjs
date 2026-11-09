// Servidor local para probar Foto4K sin instalar nada (solo Node 20+).
// Envía los mismos encabezados que Vercel (COOP/COEP), necesarios para que la IA
// use varios núcleos del procesador cuando no hay tarjeta gráfica.
//
// Uso:  npm run dev        (o: node scripts/dev-server.mjs)
//       PORT=8080 npm run dev

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../public/', import.meta.url)));
const PORT = Number(process.env.PORT) || 3000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
};

const HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
};

createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    let file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end('Prohibido');
      return;
    }
    if ((await stat(file).catch(() => null))?.isDirectory()) file = join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, { ...HEADERS, 'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { ...HEADERS, 'Content-Type': 'text/plain; charset=utf-8' }).end('No encontrado');
  }
}).listen(PORT, () => {
  console.log(`Foto4K listo en http://localhost:${PORT}`);
  console.log('Pulsa Ctrl + C para detenerlo.');
});
