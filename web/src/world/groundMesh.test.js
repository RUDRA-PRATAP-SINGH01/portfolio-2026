import test from 'node:test'
import assert from 'node:assert/strict'
import { groundNoise, groundNoiseData, lighterGrid, mxNoise } from './groundMesh.js'

// A grid like Terrain.jsx's (vertex i + n j; i along x, j along z) with the given height function, and its normals as
// three's computeVertexNormals makes them on PlaneGeometry's cells: (a, b, d), (b, c, d).
function grid(n, height, cell = .25) {
  const positions = new Float32Array(n * n * 3), normals = new Float32Array(n * n * 3)
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) positions.set([i * cell, height(i * cell, j * cell), j * cell], (i + n * j) * 3)
  const p = k => positions.subarray(k * 3, k * 3 + 3)
  const add = (a, b, c) => {
    const A = p(a), B = p(b), C = p(c), cb = [C[0] - B[0], C[1] - B[1], C[2] - B[2]], ab = [A[0] - B[0], A[1] - B[1], A[2] - B[2]]
    const f = [cb[1] * ab[2] - cb[2] * ab[1], cb[2] * ab[0] - cb[0] * ab[2], cb[0] * ab[1] - cb[1] * ab[0]]
    for (const v of [a, b, c]) for (let k = 0; k < 3; k++) normals[v * 3 + k] += f[k]
  }
  for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
    const a = i + n * j, b = i + n * (j + 1), c = i + 1 + n * (j + 1), d = i + 1 + n * j
    add(a, b, d); add(b, c, d)
  }
  for (let v = 0; v < n * n; v++) { const l = Math.hypot(normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]); for (let k = 0; k < 3; k++) normals[v * 3 + k] /= l }
  return { positions, normals }
}
const triangles = index => Array.from({ length: index.length / 3 }, (_, t) => [index[t * 3], index[t * 3 + 1], index[t * 3 + 2]])
const ij = (v, n) => [v % n, Math.floor(v / n)]
const turn = (t, n) => { const [a, b, c] = t.map(v => ij(v, n)); return (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]) }

// Rolling ground: flat on the left half, waves on the right, a ridge near the far edge.
const rolling = (x, z) => (x < 4 ? 0 : .08 * Math.sin(x * 2.1) * Math.cos(z * 1.7)) + (z > 6.5 ? .3 * Math.max(0, 1 - Math.abs(x - 3) / 1.5) : 0)

test('the noise matches the material\'s mx_noise_float (reference values of the same port in numpy)', () => {
  const expected = [[.3, .7, .0407437], [-5.25, 12.5, -.399124414], [20.4, -37.2, -.646706491], [.001, -.001, -.001984793], [-.5, -.5, .1654], [3, 4, 0], [12.34, -7.89, -.500925471]]
  for (const [x, y, value] of expected) assert.ok(Math.abs(mxNoise(x, y) - value) < 1e-8, `${x}, ${y}: ${mxNoise(x, y)}`)
  const [soil, tint] = groundNoise(.5, -1)
  assert.ok(Math.abs(soil - (mxNoise(.3, -.6) * .5 + .5)) < 1e-12 && Math.abs(tint - (mxNoise(.0425, -.085) * .5 + .5)) < 1e-12)
})

test('the noise texture holds each vertex\'s values, rows from y0 up', () => {
  const data = groundNoiseData(4, -2, 1, .5, .25)
  for (const [r, i] of [[0, 0], [3, 1], [2, 3]]) {
    const [soil, tint] = groundNoise(-2 + i * .5, -(1 + r * .25))
    assert.equal(data[(i + 4 * r) * 2], Math.fround(soil)); assert.equal(data[(i + 4 * r) * 2 + 1], Math.fround(tint))
  }
})

test('flat ground becomes two triangles per largest block', () => {
  const n = 33, { positions, normals } = grid(n, () => .5)
  const { index, blocks } = lighterGrid(positions, normals, n)
  assert.equal(index.length / 3, 2)
  assert.deepEqual(blocks, { 32: 1 })
})

test('the lighter grid is watertight, wound like PlaneGeometry, covers the grid, and stays within 2 cm and 2.5 degrees', () => {
  const n = 33, { positions, normals } = grid(n, rolling)
  const { index, fans } = lighterGrid(positions, normals, n)
  const tris = triangles(index)
  assert.ok(tris.length < 2 * 32 * 32 && fans > 0, `${tris.length} triangles, ${fans} fans`)
  // every triangle turns the same way, and together they cover the grid exactly once
  assert.ok(tris.every(t => turn(t, n) < 0))
  assert.equal(tris.reduce((sum, t) => sum - turn(t, n) / 2, 0), 32 * 32)
  // every edge inside the grid is shared by exactly two triangles, every edge on its border belongs to one
  const edges = new Map()
  for (const t of tris) for (let k = 0; k < 3; k++) { const a = t[k], b = t[(k + 1) % 3], key = Math.min(a, b) + ':' + Math.max(a, b); edges.set(key, (edges.get(key) ?? 0) + 1) }
  for (const [key, count] of edges) {
    const [a, b] = key.split(':').map(Number).map(v => ij(v, n))
    const border = (a[0] === b[0] && (a[0] === 0 || a[0] === n - 1)) || (a[1] === b[1] && (a[1] === 0 || a[1] === n - 1))
    assert.equal(count, border ? 1 : 2, key)
  }
  // at every vertex, the triangle over it gives the grid's height and normal
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const t = tris.find(t => {
      const [a, b, c] = t.map(v => ij(v, n)), d = turn(t, n)
      const wa = ((b[0] - i) * (c[1] - j) - (c[0] - i) * (b[1] - j)) / d, wb = ((c[0] - i) * (a[1] - j) - (a[0] - i) * (c[1] - j)) / d
      return wa > -1e-9 && wb > -1e-9 && 1 - wa - wb > -1e-9
    })
    const [a, b, c] = t.map(v => ij(v, n)), d = turn(t, n)
    const w = [((b[0] - i) * (c[1] - j) - (c[0] - i) * (b[1] - j)) / d, ((c[0] - i) * (a[1] - j) - (a[0] - i) * (c[1] - j)) / d]; w.push(1 - w[0] - w[1])
    const at = k => t.reduce((sum, v, m) => sum + w[m] * positions[v * 3 + k], 0), nAt = k => t.reduce((sum, v, m) => sum + w[m] * normals[v * 3 + k], 0)
    const v = i + n * j
    assert.ok(Math.abs(at(1) - positions[v * 3 + 1]) <= .02 + 1e-6, `height at ${i}, ${j}`)
    const N = [nAt(0), nAt(1), nAt(2)], cos = (N[0] * normals[v * 3] + N[1] * normals[v * 3 + 1] + N[2] * normals[v * 3 + 2]) / Math.hypot(...N)
    assert.ok(cos >= Math.cos(2.5 * Math.PI / 180) - 1e-9, `normal at ${i}, ${j}`)
  }
})

test('cells left out get no triangles; cells that stay are drawn whole', () => {
  const n = 33, { positions, normals } = grid(n, () => 0)
  const skip = (i, j) => i >= 10 && i < 14 && j >= 10 && j < 14, stay = (i, j) => i >= 9 && i < 15 && j >= 9 && j < 15
  const tris = triangles(lighterGrid(positions, normals, n, { skip, stay }).index)
  const covering = (x, y) => tris.filter(t => {
    const [a, b, c] = t.map(v => ij(v, n)), d = turn(t, n)
    const wa = ((b[0] - x) * (c[1] - y) - (c[0] - x) * (b[1] - y)) / d, wb = ((c[0] - x) * (a[1] - y) - (a[0] - x) * (c[1] - y)) / d
    return wa > 0 && wb > 0 && 1 - wa - wb > 0
  })
  assert.equal(covering(11.5, 12.5).length, 0)
  for (const [i, j] of [[9, 9], [14, 12], [12, 14]]) {
    const [t] = covering(i + .3, j + .6)
    assert.ok(t.map(v => ij(v, n)).every(([a, b]) => a >= i && a <= i + 1 && b >= j && b <= j + 1), `cell ${i}, ${j}`)
  }
  // the rest of the flat ground still merges
  assert.ok(tris.length < 200, `${tris.length} triangles`)
})

// buildGround against the way Terrain.jsx built the grid with three before it moved to a worker, on the real terrain.
test('buildGround matches three, number for number, on the real terrain', async () => {
  const THREE = await import('three')
  const { readFileSync } = await import('node:fs')
  const { buildGround, heightSampler, lighterGrid: lighter, groundNoiseData: noise } = await import('./groundMesh.js')
  const meta = JSON.parse(readFileSync(new URL('../../public/data/scene_meta.json', import.meta.url))), T = meta.terrain
  const raw = new Uint16Array(readFileSync(new URL('../../public/' + T.height_file, import.meta.url)).buffer.slice(0))
  const heights = Float32Array.from(raw, v => T.height_min + (v / 65535) * (T.height_max - T.height_min))
  const [x0, x1, y0, y1] = T.bounds_blender_xy, bounds = { x0, x1, y0, y1 }, heightAt = heightSampler(heights, T.resolution, bounds)
  const g = new THREE.PlaneGeometry(x1 - x0, y1 - y0, 255, 255)
  g.rotateX(-Math.PI / 2); g.translate((x0 + x1) / 2, 0, -(y0 + y1) / 2)
  const p = g.attributes.position
  for (let i = 0; i < p.count; i++) p.setY(i, heightAt(p.getX(i), p.getZ(i)))
  g.computeVertexNormals()
  const built = buildGround({ heights, R: T.resolution, bounds, shoreBox: T.shore?.box_blender_xy ?? null, water: meta.water_level })
  assert.deepEqual(built.positions, p.array)
  assert.deepEqual(built.normals, g.attributes.normal.array)
  assert.deepEqual(built.uvs, g.attributes.uv.array)
  assert.deepEqual(buildGround({ heights, R: T.resolution, bounds, water: meta.water_level, legacy: true }).index, Uint32Array.from(g.index.array))
  assert.deepEqual(built.noise, noise(256, x0, y0, (x1 - x0) / 255, (y1 - y0) / 255))
  assert.equal(built.index.length / 3, 30766)                               // 2 cm / 2.5 degree error budget (29,024 before the ground window moved south, 2026-11-14)
})
