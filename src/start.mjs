import { createConnection } from 'node:net';
import { loadEnvFile } from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from './server.mjs';
import { parseRoots } from './storage.mjs';
import { parseOrigin } from './immich.mjs';
import { createSetup, openBrowser } from './setup.mjs';

const host = '127.0.0.1';
const envPath = fileURLToPath(new URL('../.env', import.meta.url));

function loadConfig() {
  try {
    loadEnvFile(envPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Check the syntax and permissions in .env.');
  }
  const upstreamRaw = process.env.IMMICH_URL?.trim();
  const key = process.env.IMMICH_API_KEY?.trim();
  const accessKey = process.env.VITREIGN_ACCESS_KEY?.trim();
  const compose = process.env.IMMICH_COMPOSE_FILE?.trim();
  const publicRaw = process.env.VITREIGN_ORIGIN?.trim();
  const shareRaw = process.env.IMMICH_SHARE_ORIGIN?.trim();
  const port = Number(process.env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Set PORT between 1024 and 65535.');
  if (!!upstreamRaw !== !!key) throw new Error('Set both IMMICH_URL and IMMICH_API_KEY or leave both blank.');
  if ((upstreamRaw || publicRaw || accessKey) && !/^[0-9a-f]{64}$/i.test(accessKey ?? '')) {
    throw new Error('Set VITREIGN_ACCESS_KEY to 64 hex characters. See .env.example for the generation command.');
  }
  const upstream = upstreamRaw ? parseOrigin(upstreamRaw, 'IMMICH_URL') : '';
  const origin = publicRaw ? parseOrigin(publicRaw, 'VITREIGN_ORIGIN', ['https:']) : '';
  const shareOrigin = shareRaw ? parseOrigin(shareRaw, 'IMMICH_SHARE_ORIGIN', ['https:']) : '';
  if (shareOrigin && !upstream) throw new Error('Set IMMICH_URL and IMMICH_API_KEY before enabling guest links.');
  if (compose && !upstream) throw new Error('Set IMMICH_URL and IMMICH_API_KEY before IMMICH_COMPOSE_FILE.');
  if (compose && !isAbsolute(compose)) throw new Error('Set IMMICH_COMPOSE_FILE to an absolute path.');
  const originalFlag = process.env.VITREIGN_ORIGINALS?.trim() || '0';
  if (!['0', '1'].includes(originalFlag)) throw new Error('Set VITREIGN_ORIGINALS to 0 or 1.');
  if (originalFlag === '1' && !upstream) throw new Error('Connect Immich before enabling original downloads.');
  return { upstream, key, accessKey, origin, shareOrigin, port, compose,
    originals: originalFlag === '1', storageRoots: parseRoots(process.env.VITREIGN_STORAGE_ROOTS),
    database: process.env.VITREIGN_DB_FILE || fileURLToPath(new URL('../.data/library.sqlite', import.meta.url)) };
}

function tcp(url) {
  return new Promise((resolve) => {
    const socket = createConnection({
      host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
    });
    const finish = (result) => { socket.destroy(); resolve(result); };
    socket.setTimeout(750);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function checkUpstream(config) {
  if (!config.upstream) {
    console.log('[immich] Skipped. The sample library runs offline.');
    return;
  }
  const url = new URL(config.upstream);
  if (await tcp(url)) {
    console.log('[immich] TCP ready. Docker Compose skipped.');
    return;
  }
  if (!config.compose) {
    console.warn('[immich] TCP unavailable. Start Immich or correct IMMICH_URL, then retry in the gallery.');
    return;
  }
  console.log('[immich] Starting the configured Docker Compose stack.');
  await new Promise((resolve, reject) => {
    const child = spawn('docker', ['compose', '-f', config.compose, 'up', '-d'], {
      cwd: dirname(config.compose), stdio: 'inherit',
    });
    const failure = () => reject(new Error('Start Docker Desktop and check IMMICH_COMPOSE_FILE and its required environment.'));
    child.once('error', failure);
    child.once('exit', (code) => code === 0 ? resolve() : failure());
  });
  for (let attempt = 0; attempt < 45; attempt++) {
    if (await tcp(url)) {
      console.log('[immich] TCP ready.');
      return;
    }
    await delay(1000);
  }
  throw new Error('Immich still rejects TCP connections. Check docker compose logs and IMMICH_URL.');
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function startGallery(setupGrant = '') {
  const config = loadConfig();
  await checkUpstream(config);
  console.log('[orm] Skipped. Vitreign uses Node SQLite directly.');
  const { server, closeStore } = createApp({ ...config, setupGrant });
  const lastPort = config.origin ? config.port : Math.min(config.port + 30, 65535);
  for (let port = config.port; port <= lastPort; port++) {
    try {
      await listen(server, port);
      const shutdown = () => server.close(() => { closeStore(); process.exit(0); });
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
      const address = `http://${host}:${port}`;
      console.log(`[server] Vitreign is ready at ${address}`);
      return config.origin || address;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') {
        closeStore();
        throw new Error('Could not open the local server. Check access to the loopback interface.');
      }
      console.log(`[server] Port ${port} in use.`);
    }
  }
  closeStore();
  throw new Error('Choose a free PORT in .env and start again.');
}

async function start() {
  const launch = process.argv.includes('--launch');
  if (launch && !existsSync(envPath) && !process.env.IMMICH_URL && !process.env.IMMICH_API_KEY
    && !process.env.VITREIGN_ORIGIN && !process.env.VITREIGN_ACCESS_KEY) {
    const setup = await createSetup({ envPath, beginGallery: startGallery });
    console.log('[setup] Opening local setup in your browser. Keep this window open.');
    if (!await openBrowser(setup.url)) console.log(`[setup] Open this one-time address in your browser.\n${setup.url}`);
    return;
  }
  const address = await startGallery();
  if (launch && !await openBrowser(address)) console.log(`[server] Open ${address} in your browser.`);
}

start().catch((error) => {
  console.error(`[startup] ${error.message}`);
  process.exitCode = 1;
});
