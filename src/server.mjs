import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { ApiError, isUuid, immichClient } from './immich.mjs';
import { samples } from './sample.mjs';
import { openStore } from './store.mjs';
import { storageReport } from './storage.mjs';

const sampleMap = new Map(samples.map((item) => [item.id, item]));
const staticFiles = new Set([
  '/index.html', '/style.css', '/app.js', '/carousel.js', '/airlock.js', '/screening.js', '/brand.svg', '/icons.svg',
  '/restore.js', '/restore-worker.js', '/commands.js',
  '/media/hatch-closed.webp', '/media/hatch-open.webp',
  '/fonts/display.woff2', '/fonts/body.woff2',
  ...samples.flatMap(({ src, thumb }) => [src, thumb]),
]);
const types = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8', svg: 'image/svg+xml', webp: 'image/webp',
  mp4: 'video/mp4', woff2: 'font/woff2' };
const stillTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif']);
const videoTypes = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
const digest = (input) => createHash('sha256').update(input).digest();
const rangePattern = /^bytes=(?:\d{1,15}-\d{0,15}|-\d{1,15})$/;

function dateValid(value) {
  if (!value) return true;
  const time = Date.parse(`${value}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(time)
    && new Date(time).toISOString().startsWith(value);
}

function inDateRange(item, from, through) {
  return (!from || item.date >= from) && (!through || (item.date && item.date <= through));
}

const attachment = (title) => {
  const cleaned = title.toWellFormed().replace(/[\x00-\x1f\x7f/\\]/g, '_').trim() || 'vitreign-original';
  return "attachment; filename*=UTF-8''" + encodeURIComponent(cleaned)
    .replace(/['()*]/g, (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase());
};

export function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

export async function readJson(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
    throw new ApiError(415, 'Use a JSON request.');
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    total += chunk.length;
    if (total > 4096) {
      req.resume();
      throw new ApiError(413, 'The request is too large.');
    }
    chunks.push(chunk);
  }
  try {
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result;
  } catch {
    throw new ApiError(400, 'The JSON request is invalid.');
  }
}

async function file(req, res, path) {
  if (!staticFiles.has(path)) throw new ApiError(404, 'Page unavailable.');
  const source = fileURLToPath(new URL(`../public${path}`, import.meta.url));
  const { size } = await stat(source);
  const type = types[path.split('.').at(-1)];
  const video = type === 'video/mp4';
  let status = 200, start = 0, end = size - 1;
  const headers = { 'Content-Type': type };
  if (path === '/restore-worker.js') {
    headers['Content-Security-Policy'] = "default-src 'none'; script-src 'self'; connect-src 'none'";
  }
  if (path.startsWith('/media/') || path.startsWith('/fonts/')) headers['Cache-Control'] = 'public, max-age=3600';
  if (video) headers['Accept-Ranges'] = 'bytes';
  if (video && req.headers.range) {
    const value = req.headers.range;
    if (rangePattern.test(value)) {
      const [first, last] = value.slice(6).split('-');
      start = first ? Number(first) : Math.max(0, size - Number(last));
      end = first && last ? Math.min(Number(last), size - 1) : size - 1;
    }
    if (!rangePattern.test(value) || start > end || start >= size) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` }).end();
      return;
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  res.writeHead(status, { ...headers, 'Content-Length': end - start + 1 });
  if (req.method === 'HEAD') return res.end();
  await pipeline(createReadStream(source, { start, end }), res);
}

export function createApp({ upstream, key, accessKey, origin, shareOrigin, database,
  originals = false, storageRoots = [], setupGrant = '' }) {
  if ((upstream && !key) || ((upstream || origin) && !accessKey)) {
    throw new Error('Set the required workspace and Immich credentials before starting.');
  }
  const live = upstream ? immichClient(upstream, key) : null;
  const scope = live ? digest(`${upstream}\0${key}`).toString('hex') : 'sample';
  const store = openStore(database, scope, !live);
  const getStorage = storageReport(storageRoots);
  const authDigest = accessKey ? digest(accessKey) : null;
  let grant = setupGrant && !origin ? digest(setupGrant) : null;
  const grantUntil = Date.now() + 10 * 60_000;
  const sessions = new Map();
  const limits = new Map();
  const ttl = 12 * 60 * 60;
  const cookie = origin ? '__Host-vitreign' : 'vitreign';
  const cookieAttributes = `Path=/; HttpOnly; SameSite=Strict${origin ? '; Secure' : ''}`;

  function session(req) {
    const token = req.headers.cookie?.split(';').map((part) => part.trim())
      .find((part) => part.startsWith(`${cookie}=`))?.slice(cookie.length + 1);
    return token && sessions.get(token) > Date.now() ? token : null;
  }

  function rate(req, res, bucket, max, window) {
    const id = `${bucket}:${req.socket.remoteAddress}`;
    const now = Date.now();
    const entry = limits.get(id);
    const state = entry?.until > now ? entry : { count: 0, until: now + window };
    if (++state.count > max) {
      res.setHeader('Retry-After', Math.ceil((state.until - now) / 1000));
      throw new ApiError(429, 'Too many requests. Try again shortly.');
    }
    limits.set(id, state);
  }

  function signIn(res, secret) {
    if (!authDigest || typeof secret !== 'string' || !timingSafeEqual(authDigest, digest(secret))) {
      throw new ApiError(401, 'That access key was not accepted.');
    }
    if (sessions.size >= 50) sessions.delete(sessions.keys().next().value);
    const token = randomBytes(32).toString('base64url');
    sessions.set(token, Date.now() + ttl * 1000);
    res.setHeader('Set-Cookie', `${cookie}=${token}; ${cookieAttributes}; Max-Age=${ttl}`);
    send(res, 200, { ok: true });
  }

  const validAssetId = (id) => live ? isUuid(id) : sampleMap.has(id);
  async function findAsset(id) {
    if (!validAssetId(id)) throw new ApiError(404, 'This item is unavailable.');
    return live ? live.asset(id) : sampleMap.get(id);
  }

  async function visibleBatch(ids) {
    return (await Promise.all(ids.map(async (id) => {
      try {
        return await findAsset(id);
      } catch (error) {
        if (error.status === 404) return null;
        throw error;
      }
    }))).filter(Boolean);
  }

  function reelById(id) {
    const reel = store.snapshot().reels.find((entry) => entry.id === id);
    if (!reel) throw new ApiError(404, 'Reel unavailable.');
    return reel;
  }

  async function savedItems(ids, page, query, kind, from, through) {
    const matches = [];
    // Keep a bound on concurrent upstream requests while preserving reel order.
    for (let start = 0; start < ids.length; start += 8) {
      const batch = await visibleBatch(ids.slice(start, start + 8));
      matches.push(...batch.filter((item) => (!query || item.title.toLowerCase().includes(query.toLowerCase()))
        && (!kind || item.type === kind) && inDateRange(item, from, through)));
      if (matches.length > page * 30) break;
    }
    return { items: matches.slice((page - 1) * 30, page * 30), more: matches.length > page * 30 };
  }

  async function fullReel(res, id, index) {
    const reel = reelById(id);
    const cues = store.cues(id);
    const frames = [];
    for (let start = 0; start < reel.ids.length; start += 8) {
      frames.push(...(await visibleBatch(reel.ids.slice(start, start + 8))).map((item) =>
        cues.has(item.id) ? { ...item, cue: cues.get(item.id) } : item));
    }
    const unavailable = reel.ids.length - frames.length;
    if (!index) return send(res, 200, { title: reel.title, items: frames, unavailable });
    res.setHeader('Content-Disposition', attachment('vitreign-reel.json'));
    return send(res, 200, { format: 'vitreign-reel-index', version: 1, title: reel.title, unavailable,
      frames: frames.map(({ id: assetId, title, date, type, cue }) => ({
        assetId, title, date, type, ...(cue ? { cue } : {}),
      })) });
  }

  async function original(res, id) {
    const abort = new AbortController();
    res.once('close', () => abort.abort());
    res.setTimeout(60_000, () => res.destroy());
    const timer = setTimeout(() => abort.abort(), 15_000);
    let upstreamFile;
    try {
      upstreamFile = await live.original(id, abort.signal);
    } finally {
      clearTimeout(timer);
    }
    const { response, title } = upstreamFile;
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw new ApiError(502, 'Immich could not return the original file.');
    }
    const headers = { 'Content-Type': 'application/octet-stream', 'Content-Disposition': attachment(title) };
    const length = response.headers.get('content-length');
    if (!response.headers.has('content-encoding') && /^\d+$/.test(length ?? '')) headers['content-length'] = length;
    res.writeHead(200, headers);
    await pipeline(response.body, res, { signal: abort.signal });
  }

  async function media(req, res, id, variant) {
    const range = req.headers.range;
    if (range && !rangePattern.test(range)) throw new ApiError(416, 'Unsupported byte range.');
    const abort = new AbortController();
    res.once('close', () => abort.abort());
    const response = await live.media(id, variant, range, AbortSignal.any([
      abort.signal, AbortSignal.timeout(10 * 60_000),
    ]));
    const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (response.status === 416) {
      const contentRange = response.headers.get('content-range');
      await response.body?.cancel();
      if (contentRange) res.setHeader('Content-Range', contentRange);
      return res.writeHead(416).end();
    }
    const allowed = variant === 'video' ? videoTypes : stillTypes;
    if (!allowed.has(mime) || !response.body) {
      await response.body?.cancel();
      throw new ApiError(502, 'Immich returned an unsupported media format.');
    }
    const headers = { 'Content-Type': mime };
    for (const name of ['content-range', 'accept-ranges']) {
      if (response.headers.has(name)) headers[name] = response.headers.get(name);
    }
    if (!response.headers.has('content-encoding') && response.headers.has('content-length')) {
      headers['content-length'] = response.headers.get('content-length');
    }
    res.writeHead(response.status, headers);
    return pipeline(response.body, res, { signal: abort.signal });
  }

  async function route(req, res) {
    const localOrigin = `http://127.0.0.1:${server.address().port}`;
    const localHosts = [new URL(localOrigin).host, `localhost:${server.address().port}`];
    const allowedHosts = origin ? [...localHosts, new URL(origin).host] : localHosts;
    if (!allowedHosts.includes(req.headers.host) || !req.url?.startsWith('/')) {
      throw new ApiError(403, 'Host is not allowed.');
    }
    const url = new URL(req.url, localOrigin);
    if (url.origin !== localOrigin) throw new ApiError(403, 'Host is not allowed.');
    const path = url.pathname;
    const get = req.method === 'GET';
    const post = req.method === 'POST';
    const sameSite = req.headers['sec-fetch-site'];
    if (path.startsWith('/api/') && sameSite && !['same-origin', 'none'].includes(sameSite)) {
      throw new ApiError(403, 'Cross-origin requests are disabled.');
    }
    if (post && ![origin, localOrigin, `http://localhost:${server.address().port}`]
      .filter(Boolean).includes(req.headers.origin)) {
      throw new ApiError(403, 'Cross-origin writes are disabled.');
    }

    if (!path.startsWith('/api/')) {
      if (!get && req.method !== 'HEAD') throw new ApiError(405, 'Method unavailable.');
      return file(req, res, path === '/' ? '/index.html' : path);
    }
    rate(req, res, 'api', 900, 60_000);
    const token = session(req);
    if (get && path === '/api/status') {
      return send(res, 200, { mode: live ? 'immich' : 'sample', locked: !!authDigest && !token,
        canLock: !!authDigest, shares: !!shareOrigin, originals: !!live && originals });
    }
    if (post && path === '/api/login') {
      rate(req, res, 'login', 8, 60_000);
      if (origin && req.headers.origin !== origin) throw new ApiError(403, 'Open the configured HTTPS address.');
      return signIn(res, (await readJson(req)).key);
    }
    if (post && path === '/api/handoff' && grant) {
      rate(req, res, 'login', 8, 60_000);
      const { token: proof } = await readJson(req);
      if (!grant || Date.now() > grantUntil || typeof proof !== 'string'
        || !timingSafeEqual(grant, digest(proof))) throw new ApiError(401, 'The setup sign-in expired. Use your workspace key.');
      grant = null;
      return signIn(res, accessKey);
    }
    if (authDigest && !token) throw new ApiError(401, 'Unlock the library to continue.');
    if (post && path === '/api/logout') {
      if (token) sessions.delete(token);
      res.setHeader('Set-Cookie', `${cookie}=; ${cookieAttributes}; Max-Age=0`);
      return send(res, 200, { ok: true });
    }
    if (get && path === '/api/state') return send(res, 200, store.snapshot());
    if (get && path === '/api/albums') return send(res, 200, live ? await live.albums() : []);
    if (get && path === '/api/storage') return send(res, 200, await getStorage());
    const reelExport = path.match(/^\/api\/reels\/([\da-f-]+)\/(screen|index)$/i);
    if (get && reelExport && isUuid(reelExport[1])) {
      rate(req, res, 'reel-read', 30, 60_000);
      return fullReel(res, reelExport[1], reelExport[2] === 'index');
    }
    const cuePath = path.match(/^\/api\/reels\/([\da-f-]+)\/cue\/([\da-z-]+)$/i);
    if (get && cuePath && isUuid(cuePath[1]) && validAssetId(cuePath[2])) {
      await findAsset(cuePath[2]);
      const cue = store.cue(cuePath[1], cuePath[2]);
      if (!cue) throw new ApiError(404, 'This frame is unavailable.');
      return send(res, 200, cue);
    }
    const download = path.match(/^\/api\/original\/([\da-f-]+)$/i);
    if (get && originals && live && download && isUuid(download[1])) {
      rate(req, res, 'original', 30, 60_000);
      return original(res, download[1]);
    }
    if (post && path === '/api/share' && live && shareOrigin) {
      rate(req, res, 'share', 10, 60_000);
      const { asset } = await readJson(req);
      if (!isUuid(asset)) throw new ApiError(400, 'Invalid selection.');
      return send(res, 201, await live.share(asset, shareOrigin));
    }
    const assetMatch = path.match(/^\/api\/asset\/([\da-z-]+)$/i);
    if (get && assetMatch) return send(res, 200, await findAsset(assetMatch[1]));
    const variant = path.match(/^\/api\/media\/([\da-f-]+)\/(thumb|preview|video)$/i);
    if (get && live && variant && isUuid(variant[1])) return media(req, res, variant[1], variant[2]);

    if (get && path === '/api/library') {
      const page = Number(url.searchParams.get('page') ?? '1');
      const query = (url.searchParams.get('q') ?? '').trim();
      const kind = url.searchParams.get('kind') ?? '';
      const album = url.searchParams.get('album');
      const reel = url.searchParams.get('reel');
      const cursor = url.searchParams.get('cursor');
      const from = url.searchParams.get('from') ?? '';
      const through = url.searchParams.get('through') ?? '';
      if (query.length > 120 || !Number.isInteger(page) || page < 1 || page > 10000
        || !['', 'photo', 'video'].includes(kind) || (album && !isUuid(album)) || (reel && !isUuid(reel))
        || !dateValid(from) || !dateValid(through) || (from && through && from > through)
        || (cursor && (cursor.length > 2048 || /[^\x21-\x7e]/.test(cursor)))) {
        throw new ApiError(400, 'The library filter is invalid.');
      }
      if (reel || url.searchParams.get('favorites') === '1') {
        const ids = reel ? reelById(reel).ids : store.snapshot().favorites;
        return send(res, 200, await savedItems(ids, page, query, kind, from, through));
      }
      if (live) return send(res, 200, await live.search({ query, page, kind, cursor, album, from, through }));
      const items = samples.filter((item) => (!kind || kind === item.type) && inDateRange(item, from, through)
        && `${item.title} ${item.collection}`.toLowerCase().includes(query.toLowerCase()));
      return send(res, 200, { items: page === 1 ? items : [], more: false });
    }

    if (post && ['/api/favorite', '/api/reel', '/api/frame', '/api/reel-order', '/api/reel-cue'].includes(path)) {
      rate(req, res, 'write', 90, 60_000);
      const body = await readJson(req);
      if (path === '/api/reel') {
        if (body.action === 'delete' && isUuid(body.id)) store.removeReel(body.id);
        else if (body.action === 'create' && typeof body.title === 'string' && body.title.trim().length > 0
          && body.title.trim().length <= 80 && !/[\x00-\x1f\x7f]/.test(body.title)) {
          if (!store.createReel(body.title.trim())) throw new ApiError(409, 'This library already has 100 reels.');
        } else throw new ApiError(400, 'Enter a reel title of up to 80 characters.');
      } else if (path === '/api/reel-order') {
        if (!isUuid(body.reel) || !validAssetId(body.asset) || ![-1, 1].includes(body.step)) {
          throw new ApiError(400, 'Choose an item and a direction.');
        }
        if (!store.moveFrame(body.reel, body.asset, body.step)) throw new ApiError(409, 'The frame cannot move in that direction.');
      } else if (path === '/api/reel-cue') {
        const { reel, asset, caption, seconds } = body;
        if (!isUuid(reel) || !validAssetId(asset) || typeof caption !== 'string'
          || caption.length > 180 || /[\x00-\x09\x0b-\x1f\x7f]/.test(caption)
          || !Number.isInteger(seconds) || (seconds !== 0 && (seconds < 2 || seconds > 30))) {
          throw new ApiError(400, 'Use a caption up to 180 characters and a photo hold time of 2 to 30 seconds.');
        }
        const item = await findAsset(asset);
        if (item.type === 'video' && seconds !== 0) throw new ApiError(400, 'Videos play at their original duration.');
        if (!store.saveCue(reel, asset, caption.trim(), seconds)) throw new ApiError(404, 'This frame is unavailable.');
        return send(res, 200, { ok: true });
      } else {
        if (typeof body.enabled !== 'boolean' || !validAssetId(body.asset)
          || (path === '/api/frame' && !isUuid(body.reel))) throw new ApiError(400, 'Invalid selection.');
        if (body.enabled) await findAsset(body.asset);
        if (path === '/api/favorite') store.favorite(body.asset, body.enabled);
        else if (!store.frame(body.reel, body.asset, body.enabled)) {
          throw new ApiError(409, 'The reel is missing or has reached 100 items.');
        }
      }
      return send(res, 200, store.snapshot());
    }
    throw new ApiError(404, 'Page unavailable.');
  }

  const server = createServer({ requestTimeout: 20_000, headersTimeout: 10_000, maxHeaderSize: 8192 }, (req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self'; font-src 'self'; connect-src 'self'; worker-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cache-Control', 'no-store');
    route(req, res).catch((error) => {
      if (res.destroyed) return;
      if (res.headersSent) return res.destroy();
      if (error instanceof ApiError) return send(res, error.status, { error: error.message });
      send(res, 500, { error: 'Vitreign could not complete the request.' });
    });
  });
  return { server, closeStore: store.close };
}
