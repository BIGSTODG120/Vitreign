import { lstat, open, stat, statfs } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

const markerFile = '.vitreign-volume';

export function parseRoots(value) {
  if (!value) return [];
  try {
    const roots = JSON.parse(value);
    if (!Array.isArray(roots) || roots.length > 12) throw new Error();
    const names = new Set();
    return roots.map((root) => {
      if (!root || typeof root.name !== 'string' || typeof root.path !== 'string'
        || !root.name.trim() || root.name.trim().length > 60 || /[\x00-\x1f]/.test(root.name)
        || names.has(root.name.trim()) || !isAbsolute(root.path) || root.path.length > 1024
        || /[\x00-\x1f]/.test(root.path)
        || (root.marker !== undefined && (typeof root.marker !== 'string' || !/^[\w-]{1,80}$/.test(root.marker)))) {
        throw new Error();
      }
      const name = root.name.trim();
      names.add(name);
      return { name, path: resolve(root.path), marker: root.marker };
    });
  } catch {
    throw new Error('Set VITREIGN_STORAGE_ROOTS to a JSON array of up to 12 unique names with absolute paths. See .env.example.');
  }
}

async function markerMatches(path, expected) {
  const filename = join(path, markerFile);
  try {
    const info = await lstat(filename);
    if (!info.isFile() || info.size > 128) return false;
    const handle = await open(filename, 'r');
    try {
      const buffer = Buffer.alloc(129);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return bytesRead <= 128 && buffer.toString('utf8', 0, bytesRead).trim() === expected;
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

async function inspect({ name, path, marker }) {
  try {
    if (!(await stat(path)).isDirectory()) return { name, status: 'unavailable' };
    if (marker && !(await markerMatches(path, marker))) return { name, status: 'unverified' };
    const { bsize, blocks, bavail } = await statfs(path, { bigint: true });
    const total = bsize * blocks;
    const free = bsize * bavail;
    if (total <= 0n || free < 0n || free > total) return { name, status: 'unavailable' };
    return { name, status: marker ? 'verified' : 'reachable', total: String(total), free: String(free) };
  } catch {
    return { name, status: 'unavailable' };
  }
}

export function storageReport(roots) {
  let pending;
  let previous;
  return async () => {
    if (previous && Date.now() - previous.timestamp < 5000) return previous.report;
    // A stalled network mount can hold a filesystem call. Keep one probe in
    // flight and give the client a bounded wait without queuing further probes.
    if (!pending) pending = Promise.all(roots.map(inspect)).then((volumes) => {
      const report = { checkedAt: new Date().toISOString(), volumes };
      previous = { timestamp: Date.now(), report };
      return report;
    }).finally(() => { pending = undefined; });
    let timer;
    try {
      return await Promise.race([pending, new Promise((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout({ checkedAt: new Date().toISOString(),
          volumes: roots.map(({ name }) => ({ name, status: 'pending' })) }), 4500);
      })]);
    } finally {
      clearTimeout(timer);
    }
  };
}
