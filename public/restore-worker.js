const blockSize = 4 * 1024 * 1024;

function firstDifference(left, right) {
  if (left.byteLength !== right.byteLength) throw new Error('A selected file changed while it was being read.');
  const size = left.byteLength;
  const words = Math.floor(size / 4);
  const a = new Uint32Array(left, 0, words);
  const b = new Uint32Array(right, 0, words);
  let word = 0;
  while (word < words && a[word] === b[word]) word++;
  if (word === words && size === words * 4) return -1;
  const aBytes = new Uint8Array(left);
  const bBytes = new Uint8Array(right);
  for (let i = word * 4; i < Math.min(size, word * 4 + 4); i++) {
    if (aBytes[i] !== bBytes[i]) return i;
  }
  return -1;
}

export async function compareFiles(source, restored, onProgress = () => {}) {
  if (source.size !== restored.size) {
    return { kind: 'size', sourceBytes: source.size, restoredBytes: restored.size };
  }
  const size = source.size;
  let lastUpdate = 0;
  for (let offset = 0; offset < size; offset += blockSize) {
    const end = Math.min(offset + blockSize, size);
    const [left, right] = await Promise.all([
      source.slice(offset, end).arrayBuffer(),
      restored.slice(offset, end).arrayBuffer(),
    ]);
    if (left.byteLength !== end - offset || right.byteLength !== end - offset) {
      throw new Error('A selected file changed while it was being read.');
    }
    const mismatch = firstDifference(left, right);
    if (mismatch >= 0) return { kind: 'difference', offset: offset + mismatch, size };
    const now = performance.now();
    if (end === size || now - lastUpdate >= 120) {
      onProgress(end, size);
      lastUpdate = now;
    }
  }
  return { kind: 'match', size };
}

if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  self.addEventListener('message', async ({ data }) => {
    try {
      const result = await compareFiles(data.source, data.restored,
        (checked, size) => self.postMessage({ progress: { checked, size } }));
      self.postMessage({ result });
    } catch {
      self.postMessage({ error: 'A selected file could not be read. Reconnect its storage and choose it again.' });
    }
  }, { once: true });
}
