const mediaExtension = /\.(?:mp4|m4v|webm|mov|mp3|m4a|aac|wav|ogg|oga|ogv|flac)$/i;

function representationSize(response, getAssetSize) {
  const encoding = response.headers.get('content-encoding');
  const length = response.headers.get('content-length');
  if (encoding && encoding.trim().toLowerCase() !== 'identity') return null;
  if (length !== null && !/^\d+$/.test(length)) return null;
  const size = length === null ? getAssetSize?.() : Number(length);
  return Number.isSafeInteger(size) && size >= 0 ? size : null;
}

function byteRange(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!(suffix > 0)) return null;
    return {start: Math.max(0, size - suffix), end: size - 1};
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return start < size && start <= end ? {start, end} : null;
}

function ifRangeMatches(value, response) {
  if (!value) return true;
  if (value.startsWith('"')) return value === response.headers.get('etag');
  if (value.startsWith('W/')) return false;
  const date = Date.parse(value);
  const modified = Date.parse(response.headers.get('last-modified') || '');
  return Number.isFinite(date) && Number.isFinite(modified) && modified <= date;
}

async function discard(body, reason) {
  try { await body?.cancel(reason); } catch { /* Cancellation must not replace the asset response. */ }
}

function sliceStream(body, start, end) {
  const reader = body.getReader();
  let offset = 0;
  let finished = false;
  async function finish(reason) {
    if (finished) return;
    finished = true;
    try { await reader.cancel(reason); } catch { /* Selected bytes are complete even if upstream cancellation fails. */ } finally { reader.releaseLock(); }
  }
  return new ReadableStream({
    async pull(controller) {
      try {
        for (;;) {
          const {value, done} = await reader.read();
          if (done) {
            finished = true;
            reader.releaseLock();
            if (offset <= end) controller.error(new Error('Static asset ended before its declared Content-Length'));
            else controller.close();
            return;
          }
          const chunkStart = offset;
          offset += value.byteLength;
          const from = Math.max(start - chunkStart, 0);
          const to = Math.min(end + 1 - chunkStart, value.byteLength);
          if (to > from) controller.enqueue(value.subarray(from, to));
          if (offset > end) {
            await finish('Requested byte range complete');
            controller.close();
            return;
          }
          if (to > from) return;
        }
      } catch (error) {
        try { await finish(error); } catch { /* Preserve the original stream error. */ }
        controller.error(error);
      }
    },
    async cancel(reason) { await finish(reason); },
  }, {highWaterMark: 0});
}

/**
 * Static-asset range fallback for selected media only. The caller must route those paths
 * through its Worker; the returned handler delegates every request solely to env.ASSETS.
 * When the binding hides Content-Length, getAssetSize may supply the identity byte count
 * from the same deployed asset snapshot. Unknown lengths and encoded responses pass through.
 */
export function createStaticMediaRangeHandler({matches = pathname => mediaExtension.test(pathname), getAssetSize} = {}) {
  return async function fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    const selected = ['GET', 'HEAD'].includes(request.method) && matches(pathname);
    if (!selected) return env.ASSETS.fetch(request);
    const headers = new Headers(request.headers);
    headers.set('accept-encoding', 'identity');
    if (request.method === 'HEAD') headers.delete('range');
    const response = await env.ASSETS.fetch(new Request(request, {headers}));
    if (response.status !== 200) return response;
    const size = representationSize(response, () => getAssetSize?.(pathname));
    if (size === null) return response;
    const range = request.headers.get('range');
    const resultHeaders = new Headers(response.headers);
    resultHeaders.set('accept-ranges', 'bytes');
    if (request.method === 'HEAD') {
      await discard(response.body, 'HEAD response');
      return new Response(null, {status: response.status, statusText: response.statusText, headers: resultHeaders});
    }
    if (!range || !ifRangeMatches(request.headers.get('if-range'), response) || !response.body) {
      return new Response(response.body, {status: response.status, statusText: response.statusText, headers: resultHeaders});
    }
    const bounds = byteRange(range, size);
    if (!bounds) {
      await discard(response.body, 'Invalid or unsatisfiable byte range');
      resultHeaders.set('content-range', `bytes */${size}`);
      resultHeaders.set('content-length', '0');
      return new Response(null, {status: 416, headers: resultHeaders});
    }
    resultHeaders.set('content-range', `bytes ${bounds.start}-${bounds.end}/${size}`);
    resultHeaders.set('content-length', String(bounds.end - bounds.start + 1));
    const body = sliceStream(response.body, bounds.start, bounds.end);
    if (typeof FixedLengthStream === 'undefined') return new Response(body, {status: 206, headers: resultHeaders});
    // Workers derive the HTTP length from the response body and ignore a manually set header.
    const stream = new FixedLengthStream(bounds.end - bounds.start + 1);
    // pipeTo reports failures on the readable stream returned to the caller.
    void body.pipeTo(stream.writable).catch(() => {});
    return new Response(stream.readable, {status: 206, headers: resultHeaders});
  };
}
