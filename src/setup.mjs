import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { link, open, readFile, unlink } from 'node:fs/promises';
import { once } from 'node:events';
import { ApiError, immichClient, parseOrigin } from './immich.mjs';
import { readJson, send } from './server.mjs';

const assets = new Map([
  ['/', ['setup.html', 'text/html; charset=utf-8']],
  ['/setup.js', ['setup.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/brand.svg', ['brand.svg', 'image/svg+xml']],
  ['/fonts/body.woff2', ['fonts/body.woff2', 'font/woff2']],
  ['/fonts/display.woff2', ['fonts/display.woff2', 'font/woff2']],
  ['/media/hatch-closed.webp', ['media/hatch-closed.webp', 'image/webp']],
]);

export function openBrowser(address) {
  const [file, args] = process.platform === 'win32'
    ? ['rundll32.exe', ['url.dll,FileProtocolHandler', address]]
    : [process.platform === 'darwin' ? 'open' : 'xdg-open', [address]];
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: 'ignore', windowsHide: true });
    child.once('error', () => resolve(false));
    child.once('exit', (status) => resolve(status === 0));
  });
}

async function saveEnvironment(path, values) {
  const temp = `${path}.setup-${randomBytes(10).toString('hex')}`;
  let created = false;
  try {
    const file = await open(temp, 'wx', 0o600);
    created = true;
    try {
      const text = Object.entries(values).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join('\n');
      await file.writeFile(`${text}\n`, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await link(temp, path);
  } catch (error) {
    if (error.code === 'EEXIST') throw new ApiError(409, 'A settings file already exists. Close setup and relaunch Vitreign.');
    throw new ApiError(500, 'Vitreign could not save settings. Extract it to a writable folder on your computer and try again.');
  } finally {
    if (created) await unlink(temp).catch(() => {});
  }
}

export async function createSetup({ envPath, beginGallery }) {
  const capability = randomBytes(24).toString('base64url');
  const authorization = Buffer.from(`Bearer ${capability}`);
  let address;
  let expires;
  let busy = false;
  let finished = false;

  function complete(res, result) {
    finished = true;
    clearTimeout(expires);
    res.once('finish', () => server.close());
    return send(res, 200, result);
  }

  async function handle(req, res) {
    if (req.headers.host !== new URL(address).host) throw new ApiError(403, 'Open setup from the Vitreign launcher.');
    if (req.method === 'GET' && assets.has(req.url)) {
      const [file, type] = assets.get(req.url);
      const bytes = await readFile(new URL(`../public/${file}`, import.meta.url));
      return res.writeHead(200, { 'Content-Type': type }).end(bytes);
    }
    if (req.method !== 'POST' || req.url !== '/api/setup') throw new ApiError(404, 'Page unavailable.');
    const supplied = Buffer.from(req.headers.authorization ?? '');
    if (req.headers.origin !== address || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')
      || supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)) {
      throw new ApiError(403, 'Open setup from the Vitreign launcher.');
    }
    if (finished) throw new ApiError(410, 'Setup finished. Open Vitreign from the launcher.');
    if (busy) throw new ApiError(409, 'A connection check is in progress.');
    busy = true;
    try {
      const data = await readJson(req);
      if (data.mode === 'sample') return complete(res, { gallery: await beginGallery() });
      if (data.mode !== 'immich' || typeof data.url !== 'string' || data.url.length > 512
        || typeof data.key !== 'string' || !/^[A-Za-z0-9._+/=-]{10,200}$/.test(data.key.trim())) {
        throw new ApiError(400, 'Enter your Immich address and a valid API key.');
      }
      let upstream;
      try { upstream = parseOrigin(data.url.trim(), 'Immich', undefined, true); }
      catch (error) { throw new ApiError(400, error.message); }
      const key = data.key.trim();
      const immich = immichClient(upstream, key);
      const [library] = await Promise.all([immich.search({ page: 1, size: 1 }), immich.albums()]);
      if (library.items.length) {
        try {
          const preview = await immich.media(library.items[0].id, 'thumb');
          await preview.body?.cancel();
        } catch (error) {
          if (error.status !== 404) throw error;
        }
      }
      const accessKey = randomBytes(32).toString('hex');
      const welcome = randomBytes(24).toString('base64url');
      await saveEnvironment(envPath, { IMMICH_URL: upstream, IMMICH_API_KEY: key, VITREIGN_ACCESS_KEY: accessKey });
      const gallery = new URL(await beginGallery(welcome));
      gallery.hash = `welcome=${welcome}`;
      return complete(res, { gallery: gallery.href, accessKey, empty: library.items.length === 0 });
    } finally {
      busy = false;
    }
  }

  const server = createServer({ headersTimeout: 8_000, requestTimeout: 20_000, maxHeaderSize: 8192 }, (req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    handle(req, res).catch((error) => {
      if (res.destroyed) return;
      if (res.headersSent) return res.destroy();
      send(res, error instanceof ApiError ? error.status : 500, error instanceof ApiError
        ? { error: error.message } : { error: 'Setup could not start the gallery. Close setup and reopen Vitreign.' });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  address = `http://127.0.0.1:${server.address().port}`;
  expires = setTimeout(() => {
    server.close();
    if (!finished) console.warn('Setup expired. Reopen Vitreign to try again.');
  }, 20 * 60_000);
  expires.unref();
  server.once('close', () => clearTimeout(expires));
  return { address, capability, close: () => server.close(), url: `${address}/#setup=${capability}` };
}
