// Downloads that may arrive gzipped. Static hosts compress text on the fly but send models and raw data as they
// are stored, so the build stores those gzipped under their own names (vite.config.js) and the page unpacks them;
// the development server sends them plain. A file is unpacked when it starts with gzip's two magic bytes, which
// none of these formats do (a .glb starts with "glTF"), so both kinds of file work everywhere.

/** The file's own bytes, unpacked if they arrived gzipped. */
export async function unpacked(buffer) {
  const head = new Uint8Array(buffer, 0, Math.min(2, buffer.byteLength))
  if (head[0] !== 0x1f || head[1] !== 0x8b) return buffer
  return new Response(new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
}

/** fetch(), but a failed response throws, naming the file and the status ("<label> unavailable: <url> (404)"). */
export async function fetchOk(url, { signal, label = 'Asset' } = {}) {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`${label} unavailable: ${url} (${response.status})`)
  return response
}

/** Fetches a file and returns its bytes, unpacked. onProgress gets the share downloaded (0..1) when the size is
 *  known; a failed response throws, naming the file. */
export async function download(url, { signal, onProgress, label = 'Asset' } = {}) {
  const response = await fetchOk(url, { signal, label })
  const total = Number(response.headers.get('content-length'))
  if (!onProgress || !total || !response.body) return unpacked(await response.arrayBuffer())
  // A host that compresses the file on the way announces the compressed length and the browser hands over more
  // than that: the share is capped, never trusted for the buffer's size.
  const parts = [], reader = response.body.getReader()
  let loaded = 0
  for (let part; !(part = await reader.read()).done;) { parts.push(part.value); loaded += part.value.length; onProgress(Math.min(1, loaded / total)) }
  return unpacked(await new Blob(parts).arrayBuffer())
}
