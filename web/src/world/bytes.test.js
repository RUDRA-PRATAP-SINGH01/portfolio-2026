import test from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { download, unpacked } from './bytes.js'

const bytesOf = buffer => [...new Uint8Array(buffer)]

test('plain files pass through, gzipped ones are unpacked', async () => {
  const glb = Uint8Array.from([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0])                  // "glTF" header start
  assert.deepEqual(bytesOf(await unpacked(glb.buffer)), bytesOf(glb))
  assert.deepEqual(bytesOf(await unpacked(new Uint8Array(gzipSync(glb)).buffer)), bytesOf(glb))   // (a Buffer shares a pool)
  assert.equal((await unpacked(new ArrayBuffer(0))).byteLength, 0)
  assert.deepEqual(bytesOf(await unpacked(Uint8Array.of(0x1f).buffer)), [0x1f])        // one byte: not gzip
})

test('download reports progress, unpacks, and names the file when it fails', async t => {
  const data = Uint8Array.from({ length: 5000 }, (_, i) => i % 7)
  const packed = gzipSync(data), seen = []
  t.mock.method(globalThis, 'fetch', async url => url === '/missing' ? new Response('no', { status: 404 })
    : new Response(packed, { headers: { 'content-length': String(packed.length) } }))
  assert.deepEqual(bytesOf(await download('/data.bin', { onProgress: share => seen.push(share) })), bytesOf(data))
  assert.equal(seen.at(-1), 1)
  assert.deepEqual(bytesOf(await download('/data.bin')), bytesOf(data))
  await assert.rejects(download('/missing', { label: 'Terrain' }), /Terrain unavailable: \/missing \(404\)/)
  // Announced shorter than it arrives (a host compressing on the way): all of it, and the share stops at 1.
  t.mock.method(globalThis, 'fetch', async () => new Response(packed, { headers: { 'content-length': '10' } }))
  seen.length = 0
  assert.deepEqual(bytesOf(await download('/data.bin', { onProgress: share => seen.push(share) })), bytesOf(data))
  assert.ok(seen.every(share => share <= 1))
})
