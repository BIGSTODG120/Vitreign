const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
export const isUuid = (value) => typeof value === 'string' && uuid.test(value);

export function parseOrigin(value, label, schemes = ['https:', 'http:'], allowApiPath = false) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`Enter a complete ${label} URL.`); }
  const pathAllowed = url.pathname === '/' || (allowApiPath && /^\/api\/?$/.test(url.pathname));
  if (!schemes.includes(url.protocol) || url.username || url.password || url.search || url.hash || !pathAllowed) {
    throw new Error(`Use the ${label} address without a path or embedded credentials.`);
  }
  return url.origin;
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function displayDuration(value) {
  if (typeof value === 'string') return value.split('.')[0].replace(/^0+:(?=\d{2}:)/, '');
  if (!Number.isFinite(value) || value < 0) return '';
  const total = Math.floor(value / 1000);
  const hours = Math.floor(total / 3600);
  const mins = String(Math.floor(total / 60) % 60).padStart(2, '0');
  const seconds = String(total % 60).padStart(2, '0');
  return `${hours ? `${hours}:` : ''}${mins}:${seconds}`;
}

function normalize(asset) {
  if (!isUuid(asset?.id) || !['IMAGE', 'VIDEO'].includes(asset.type)
    || asset.isTrashed || asset.isOffline || asset.isArchived
    || (asset.visibility && asset.visibility !== 'timeline')) return null;
  const type = asset.type === 'VIDEO' ? 'video' : 'photo';
  return {
    id: asset.id,
    type,
    title: String(asset.originalFileName || 'Untitled').slice(0, 220),
    date: String(asset.fileCreatedAt || asset.localDateTime || '').slice(0, 10),
    duration: type === 'video' ? displayDuration(asset.duration) : '',
    thumb: `/api/media/${asset.id}/thumb`,
    src: `/api/media/${asset.id}/${type === 'video' ? 'video' : 'preview'}`,
  };
}

export function immichClient(base, key) {
  async function request(path, { body, range, signal, method } = {}) {
    const headers = { 'x-api-key': key };
    if (body) headers['content-type'] = 'application/json';
    if (range) headers.range = range;
    let response;
    try {
      response = await fetch(`${base}/api${path}`, {
        method: method ?? (body ? 'POST' : 'GET'),
        headers, body: body ? JSON.stringify(body) : undefined, redirect: 'error',
        signal: signal ?? AbortSignal.timeout(12000),
      });
    } catch {
      throw new ApiError(502, 'Cannot reach Immich. Check the server URL and network.');
    }
    if (response.ok || response.status === 416) return response;
    await response.body?.cancel();
    if (response.status === 404) throw new ApiError(404, 'This item is unavailable.');
    if ([401, 403].includes(response.status)) {
      throw new ApiError(502, 'Immich refused access. Check the API key and its permissions.');
    }
    throw new ApiError(502, 'Immich could not complete the request.');
  }

  async function json(path, options) {
    const response = await request(path, options);
    try {
      return await response.json();
    } catch {
      throw new ApiError(502, 'Immich returned an unreadable response.');
    }
  }

  async function asset(id) {
    const result = normalize(await json(`/assets/${id}`));
    if (!result || result.id !== id) throw new ApiError(404, 'This item is unavailable.');
    return result;
  }

  return {
    asset,
    async search({ query, page, kind, cursor, album, from, through, size = 30 }) {
      const data = await json('/search/metadata', { body: {
        ...(cursor ? { cursor } : { page }), size, order: 'desc', visibility: 'timeline',
        ...(album ? { albumIds: [album] } : {}),
        ...(from ? { takenAfter: `${from}T00:00:00.000Z` } : {}),
        ...(through ? { takenBefore: `${through}T23:59:59.999Z` } : {}),
        ...(query ? { originalFileName: query } : {}),
        ...(kind ? { type: kind === 'photo' ? 'IMAGE' : 'VIDEO' } : {}),
      } });
      if (!Array.isArray(data.assets?.items)) throw new ApiError(502, 'The Immich search API returned an unexpected result.');
      const nextCursor = data.assets.nextCursor || null;
      return { items: data.assets.items.map(normalize).filter(Boolean), more: !!(nextCursor || data.assets.nextPage), cursor: nextCursor };
    },
    async albums() {
      const data = await json('/albums');
      if (!Array.isArray(data)) throw new ApiError(502, 'The Immich albums API returned an unexpected result.');
      return data.filter((album) => isUuid(album.id)).map((album) => ({
        id: album.id, title: String(album.albumName || 'Untitled album').slice(0, 220),
        count: Number(album.assetCount) || 0,
        thumb: isUuid(album.albumThumbnailAssetId) ? `/api/media/${album.albumThumbnailAssetId}/thumb` : '',
      }));
    },
    async media(id, variant, range, signal) {
      const item = await asset(id);
      if (variant === 'video' && item.type !== 'video') throw new ApiError(404, 'Video unavailable.');
      if (variant === 'video') return request(`/assets/${id}/video/playback`, { range, signal });
      return request(`/assets/${id}/thumbnail?size=${variant === 'thumb' ? 'thumbnail' : 'preview'}`, { signal });
    },
    async original(id, signal) {
      const item = await asset(id);
      const response = await request(`/assets/${id}/original`, { signal });
      return { response, title: item.title };
    },
    async share(id, shareOrigin) {
      await asset(id);
      const result = await json('/shared-links', { body: {
        type: 'INDIVIDUAL', assetIds: [id], allowUpload: false, allowDownload: false,
        showMetadata: false, expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
      } });
      if (typeof result.key !== 'string' || !/^[\w-]{16,256}$/.test(result.key)) {
        throw new ApiError(502, 'Check Immich for the guest link. Its response format was unexpected.');
      }
      return { url: `${shareOrigin}/share/${result.key}` };
    },
  };
}
