import assert from 'node:assert/strict';
import { once } from 'node:events';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../src/server.mjs';
import { parseRoots } from '../src/storage.mjs';
import { compareFiles } from '../public/restore-worker.js';
import { createSetup } from '../src/setup.mjs';
import { parseOrigin } from '../src/immich.mjs';

async function fixture(context) {
  const folder = await mkdtemp(join(tmpdir(), 'vitreign-check-'));
  context.after(() => rm(folder, { recursive: true, force: true }));
  return join(folder, 'library.sqlite');
}

async function start(database, accessKey, options = {}) {
  const { server, closeStore } = createApp({ database, accessKey, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    get: (route, headers) => fetch(origin + route, { headers }),
    post: (route, body, headers) => fetch(origin + route, {
      method: 'POST', body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', Origin: origin, ...headers },
    }),
    async close() {
      await new Promise((resolve) => server.close(resolve));
      closeStore();
    },
  };
}

test('sample media, filters, and video byte ranges', async (context) => {
  const app = await start(await fixture(context));
  try {
    const response = await app.get('/');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
    assert.match(response.headers.get('content-security-policy'), /worker-src 'self'/);
    const worker = await app.get('/restore-worker.js');
    assert.equal(worker.status, 200);
    assert.match(worker.headers.get('content-security-policy'), /connect-src 'none'/);
    await worker.text();
    assert.match(await response.text(), /Vitreign/);
    const { items } = await (await app.get('/api/library?kind=video')).json();
    assert.deepEqual(items.map(({ id }) => id), ['headland']);
    const range = await app.get(items[0].src, { Range: 'bytes=0-63' });
    assert.equal(range.status, 206);
    assert.match(range.headers.get('content-range'), /^bytes 0-63\//);
    assert.equal((await range.arrayBuffer()).byteLength, 64);
    const unsupported = await app.get(items[0].src, { Range: 'bytes=999999999-' });
    assert.equal(unsupported.status, 416);
  } finally {
    await app.close();
  }
});

test('migration, sample seed, favorite and reel writes survive restart', async (context) => {
  const database = await fixture(context);
  let app = await start(database);
  try {
    const initial = await (await app.get('/api/state')).json();
    assert.equal(initial.reels.length, 1);
    assert.equal(initial.reels[0].ids.length, 3);
    await app.post('/api/reel', { action: 'delete', id: initial.reels[0].id });
    const { reels: [reel] } = await (await app.post('/api/reel', {
      action: 'create', title: 'Weekend',
    })).json();
    await app.post('/api/frame', { reel: reel.id, asset: 'alpine', enabled: true });
    await app.post('/api/frame', { reel: reel.id, asset: 'headland', enabled: true });
    await app.post('/api/frame', { reel: reel.id, asset: 'alpine', enabled: true });
    await app.post('/api/favorite', { asset: 'alpine', enabled: true });
    await app.close();
    app = await start(database);
    const persisted = await (await app.get('/api/state')).json();
    assert.deepEqual(persisted.reels, [{ ...reel, ids: ['alpine', 'headland'] }]);
    assert.deepEqual(persisted.favorites, ['alpine']);
    const { items } = await (await app.get(`/api/library?reel=${reel.id}`)).json();
    assert.deepEqual(items.map(({ id }) => id), ['alpine', 'headland']);
  } finally {
    await app.close();
  }
});

test('workspace authentication, write origin, and input boundaries', async (context) => {
  const key = randomBytes(32).toString('hex');
  const app = await start(await fixture(context), key);
  try {
    assert.equal((await app.get('/api/state')).status, 401);
    assert.equal((await app.post('/api/login', { key }, { Origin: 'https://external.example' })).status, 403);
    assert.equal((await app.post('/api/login', { key: 'wrong' })).status, 401);
    const response = await app.post('/api/login', { key });
    const setCookie = response.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly; SameSite=Strict/);
    const Cookie = setCookie.split(';')[0];
    assert.equal((await app.get('/api/state', { Cookie })).status, 200);
    assert.equal((await app.get('/.env', { Cookie })).status, 404);
    assert.equal((await app.get('/api/state', { Cookie, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await app.post('/api/reel', { action: 'create', title: 'x'.repeat(5000) }, { Cookie })).status, 413);
    assert.equal((await app.post('/api/frame', { reel: 'wrong', asset: 'alpine', enabled: true }, { Cookie })).status, 400);
    assert.equal((await app.post('/api/logout', {}, { Cookie })).status, 200);
    assert.equal((await app.get('/api/state', { Cookie })).status, 401);
  } finally {
    await app.close();
  }
});

test('inclusive capture-date bounds and validation', async (context) => {
  const app = await start(await fixture(context));
  try {
    const valid = await (await app.get('/api/library?from=2026-10-09&through=2026-10-12')).json();
    assert.deepEqual(valid.items.map(({ id }) => id), ['nightfall', 'afterglow']);
    assert.equal((await app.get('/api/library?from=2026-02-30')).status, 400);
    assert.equal((await app.get('/api/library?from=2026-10-12&through=2026-10-09')).status, 400);
  } finally {
    await app.close();
  }
});

test('reel frame order drives screening and portable index', async (context) => {
  const app = await start(await fixture(context));
  try {
    const { reels: [reel] } = await (await app.get('/api/state')).json();
    assert.equal((await app.post('/api/reel-order', { reel: reel.id, asset: 'headland', step: -1 })).status, 200);
    assert.equal((await app.post('/api/reel-order', { reel: reel.id, asset: 'headland', step: -1 })).status, 409);
    const expected = ['headland', 'dunes', 'glacier'];
    const screen = await (await app.get(`/api/reels/${reel.id}/screen`)).json();
    assert.deepEqual(screen.items.map(({ id }) => id), expected);
    const index = await app.get(`/api/reels/${reel.id}/index`);
    assert.match(index.headers.get('content-disposition'), /^attachment/);
    const report = await index.json();
    assert.equal(report.format, 'vitreign-reel-index');
    assert.deepEqual(report.frames.map(({ assetId }) => assetId), expected);
    assert.deepEqual(Object.keys(report.frames[0]), ['assetId', 'title', 'date', 'type']);
  } finally {
    await app.close();
  }
});

test('archive verifies the configured storage marker without exposing host paths', async (context) => {
  const database = await fixture(context);
  const path = dirname(database);
  await writeFile(join(path, '.vitreign-volume'), 'media-verified\n');
  assert.throws(() => parseRoots('[{"name":"bad","path":"relative"}]'));
  const storageRoots = parseRoots(JSON.stringify([
    { name: 'Media disk', path, marker: 'media-verified' },
    { name: 'Different disk', path, marker: 'wrong-marker' },
    { name: 'Offline disk', path: join(path, 'missing') },
  ]));
  const app = await start(database, undefined, { storageRoots });
  try {
    const { volumes } = await (await app.get('/api/storage')).json();
    assert.equal(volumes[0].status, 'verified');
    assert.ok(BigInt(volumes[0].total) >= BigInt(volumes[0].free));
    assert.deepEqual(volumes.slice(1).map(({ status }) => status), ['unverified', 'unavailable']);
    assert.ok(volumes.every((volume) => !('path' in volume) && !('marker' in volume)));
    assert.equal((await app.get('/api/original/28de6741-ad62-452a-a6a6-364bc1ae21f7')).status, 404);
  } finally {
    await app.close();
  }
});

test('restore check detects exact equality, unequal sizes and the first changed byte across blocks', async () => {
  const length = 4 * 1024 * 1024 + 7;
  const bytes = new Uint8Array(length).fill(62);
  const source = new File([bytes], 'source.bin');
  const copy = new File([bytes], 'copy.bin');
  const checked = [];
  assert.deepEqual(await compareFiles(source, copy, (count) => checked.push(count)), { kind: 'match', size: length });
  assert.equal(checked.at(-1), length);
  bytes[length - 2] = 61;
  assert.deepEqual(await compareFiles(source, new File([bytes], 'changed.bin')),
    { kind: 'difference', offset: length - 2, size: length });
  bytes[2] = 63;
  assert.deepEqual(await compareFiles(source, new File([bytes], 'early.bin')),
    { kind: 'difference', offset: 2, size: length });
  assert.deepEqual(await compareFiles(source, new File([], 'empty.bin')),
    { kind: 'size', sourceBytes: length, restoredBytes: 0 });
  assert.deepEqual(await compareFiles(new File([], 'empty.bin'), new File([], 'copy.bin')), { kind: 'match', size: 0 });
});

test('existing schema adds reel cues without losing data, and cues follow a reordered frame', async (context) => {
  const path = await fixture(context);
  const db = new DatabaseSync(path);
  const reel = 'febe10f4-5a46-4f8b-ba6e-c48c70bcde12';
  db.exec(`
    CREATE TABLE favorite (scope TEXT, asset TEXT, PRIMARY KEY (scope, asset)) STRICT;
    CREATE TABLE reel (scope TEXT, id TEXT, title TEXT, PRIMARY KEY (scope, id)) STRICT;
    CREATE TABLE frame (seq INTEGER PRIMARY KEY, scope TEXT, reel TEXT, asset TEXT,
      UNIQUE(scope,reel,asset), FOREIGN KEY(scope,reel) REFERENCES reel(scope,id) ON DELETE CASCADE) STRICT;
    INSERT INTO reel VALUES ('sample','${reel}','Travel');
    INSERT INTO favorite VALUES ('sample','dunes');
    INSERT INTO frame (scope,reel,asset) VALUES ('sample','${reel}','dunes'),('sample','${reel}','headland');
    PRAGMA user_version=1;
  `);
  db.close();
  const app = await start(path);
  try {
    const stored = await (await app.get('/api/state')).json();
    assert.deepEqual(stored, { favorites: ['dunes'], reels: [{ id: reel, title: 'Travel', ids: ['dunes', 'headland'] }] });
    const caption = 'First light & tire tracks';
    const cue = { reel, asset: 'dunes', caption, seconds: 6 };
    assert.equal((await app.post('/api/reel-cue', { ...cue, seconds: 31 })).status, 400);
    assert.equal((await app.post('/api/reel-cue', { ...cue, asset: 'headland' })).status, 400);
    assert.equal((await app.post('/api/reel-cue', cue)).status, 200);
    assert.equal((await app.post('/api/reel-order', { reel, asset: 'dunes', step: 1 })).status, 200);
    const screen = await (await app.get(`/api/reels/${reel}/screen`)).json();
    assert.deepEqual(screen.items.map(({ id }) => id), ['headland', 'dunes']);
    assert.deepEqual(screen.items[1].cue, { caption, seconds: 6 });
    const index = await (await app.get(`/api/reels/${reel}/index`)).json();
    assert.deepEqual(index.frames[1].cue, { caption, seconds: 6 });
    assert.equal((await app.post('/api/reel-cue', { ...cue, caption: '', seconds: 0 })).status, 200);
    const reset = await (await app.get(`/api/reels/${reel}/screen`)).json();
    assert.equal(reset.items[1].cue, undefined);
  } finally {
    await app.close();
  }
});

test('setup requires a local one-time capability and sample setup writes no credentials', async (context) => {
  assert.equal(parseOrigin('http://api', 'Immich', undefined, true), 'http://api');
  assert.equal(parseOrigin('https://immich.example/api/', 'Immich', undefined, true), 'https://immich.example');
  assert.throws(() => parseOrigin('https://immich.example/api?token=hidden', 'Immich', undefined, true));
  const path = await fixture(context);
  const envPath = join(dirname(path), '.env');
  let starts = 0;
  const setup = await createSetup({ envPath, beginGallery: async () => {
    starts++;
    return 'http://127.0.0.1:4173';
  } });
  try {
    const page = await fetch(setup.address);
    assert.match(await page.text(), /Check and connect/);
    const trySetup = (origin, authorization) => fetch(`${setup.address}/api/setup`, {
      method: 'POST', headers: { Origin: origin, Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'sample' }),
    });
    assert.equal((await trySetup(setup.address, 'Bearer invalid')).status, 403);
    assert.equal((await trySetup('https://external.example', `Bearer ${setup.capability}`)).status, 403);
    assert.equal(starts, 0);
    const success = await trySetup(setup.address, `Bearer ${setup.capability}`);
    assert.deepEqual(await success.json(), { gallery: 'http://127.0.0.1:4173' });
    assert.equal(starts, 1);
    await assert.rejects(access(envPath), { code: 'ENOENT' });
  } finally {
    setup.close();
  }
});

test('workspace setup handoff signs in once and issues the normal HttpOnly cookie', async (context) => {
  const accessKey = randomBytes(32).toString('hex');
  const setupGrant = randomBytes(24).toString('base64url');
  const app = await start(await fixture(context), accessKey, { setupGrant });
  try {
    assert.equal((await app.post('/api/handoff', { token: 'wrong' })).status, 401);
    const handoff = await app.post('/api/handoff', { token: setupGrant });
    assert.equal(handoff.status, 200);
    const cookie = handoff.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly; SameSite=Strict/);
    assert.equal((await app.post('/api/handoff', { token: setupGrant })).status, 401);
    const state = await app.get('/api/state', { Cookie: cookie.split(';')[0] });
    assert.equal(state.status, 200);
    assert.doesNotMatch(await state.text(), new RegExp(accessKey));
  } finally {
    await app.close();
  }
});
