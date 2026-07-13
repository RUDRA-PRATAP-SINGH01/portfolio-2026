// The ground grid's lighter triangle list, and its colour noise as a texture (world/Terrain.jsx).
//
// The grid keeps every vertex (256 x 256, 27 cm apart) with the normals of the full grid; only its triangle list is
// lighter. Square blocks of 2 to 32 cells are drawn with two triangles where the surface stays within 2 cm and its
// normals within 2.5 degrees of the full grid's at every vertex inside. A block beside finer cells is drawn as a fan
// from its centre through every vertex they use on the shared edge, so no crack can open there. Cells near the
// waterline (where the water line would move) and next to the island's shore patch always stay whole.
// The material's two noises (soil patches and the slow tint drift) used to be worked out at each vertex and blended
// across each triangle, so bigger triangles would blur them; they are now read from a texture that holds the same
// values at the same vertices, blended the same way at any triangle size.
// Terrain.jsx also leaves out the cells under deep water, which the opaque pond always covers.
// Measured on the Intel laptop (2026-11-13), against ?groundLegacy: 127,170 -> 57,177 triangles; main view
// 13.92 -> 13.09 ms still and 17.07 -> 16.29 ms with the pointer moving, lily pads 13.00 -> 12.08, statue -0.2,
// bank -0.15. Most of that is the ground under the water no longer shaded; the lighter list alone gave -0.1 ms
// still and -0.2 to -0.3 ms moving (the pond's reflection draws the ground again every frame then).
// Same look: largest local change 1 in seven views, clarity numbers unchanged; ?groundDebug shows the two noises
// matching the old per-vertex ones.

export const GROUND_LIGHTER = Object.freeze({ height: .02, normalDeg: 2.5, sizes: [2, 4, 8, 16, 32], waterBand: .12 })

// mx_noise_float for a vec2 (three/src/nodes/materialx/MaterialXNoise.js: 2D Perlin noise, Jenkins lookup3 hash),
// so the texture holds exactly what the shader computed per vertex.
const rotl = (x, k) => ((x << k) | (x >>> (32 - k))) >>> 0
function bjfinal(a, b, c) {
  c = ((c ^ b) >>> 0) - rotl(b, 14) >>> 0; a = ((a ^ c) >>> 0) - rotl(c, 11) >>> 0; b = ((b ^ a) >>> 0) - rotl(a, 25) >>> 0
  c = ((c ^ b) >>> 0) - rotl(b, 16) >>> 0; a = ((a ^ c) >>> 0) - rotl(c, 4) >>> 0; b = ((b ^ a) >>> 0) - rotl(a, 14) >>> 0
  return ((c ^ b) >>> 0) - rotl(b, 24) >>> 0
}
const SEED = (0xdeadbeef + (2 << 2) + 13) >>> 0
const hash = (x, y) => bjfinal((SEED + x) >>> 0, (SEED + y) >>> 0, SEED)
const gradient = (h, x, y) => { h &= 7; const u = h < 4 ? x : y, v = 2 * (h < 4 ? y : x); return (h & 1 ? -u : u) + (h & 2 ? -v : v) }
const fade = t => t * t * t * (t * (t * 6 - 15) + 10)
export function mxNoise(x, y) {
  const X = Math.floor(x), Y = Math.floor(y), fx = x - X, fy = y - Y, u = fade(fx), v = fade(fy)
  const g00 = gradient(hash(X, Y), fx, fy), g10 = gradient(hash(X + 1, Y), fx - 1, fy)
  const g01 = gradient(hash(X, Y + 1), fx, fy - 1), g11 = gradient(hash(X + 1, Y + 1), fx - 1, fy - 1)
  return .6616 * ((1 - v) * (g00 * (1 - u) + g10 * u) + v * (g01 * (1 - u) + g11 * u))
}

// The ground material's two noises at a point (three.js x, z): soil patches and the slow drift of tint, 0..1.
export const groundNoise = (x, z) => [mxNoise(x * .6, z * .6) * .5 + .5, mxNoise(x * .085, z * .085) * .5 + .5]

// Interpolation of a block's corner values f = [f00, f10, f01, f11, centre] at local (u, v) in 0..1, drawn as
// FAN (four triangles from the centre), D1 (two, PlaneGeometry's diagonal f10-f01) or D2 (two, diagonal f00-f11).
const FAN = 0, D1 = 1, D2 = 2
function interpolate(f, u, v, form) {
  if (form === D1) return u + v <= 1 ? f[0] + u * (f[1] - f[0]) + v * (f[2] - f[0]) : f[3] + (1 - u) * (f[2] - f[3]) + (1 - v) * (f[1] - f[3])
  if (form === D2) return v >= u ? f[0] + u * (f[3] - f[2]) + v * (f[2] - f[0]) : f[0] + u * (f[1] - f[0]) + v * (f[3] - f[1])
  const m = f[4]
  if (v <= Math.min(u, 1 - u)) return f[0] + u * (f[1] - f[0]) + v * (2 * m - f[0] - f[1])
  if (v >= Math.max(u, 1 - u)) return f[2] + u * (f[3] - f[2]) + (1 - v) * (2 * m - f[2] - f[3])
  if (u <= Math.min(v, 1 - v)) return f[0] + v * (f[2] - f[0]) + u * (2 * m - f[0] - f[2])
  return f[1] + v * (f[3] - f[1]) + (1 - u) * (2 * m - f[1] - f[3])
}

/**
 * The grid's lighter triangle list.
 * positions, normals: the grid's n x n vertices in PlaneGeometry order (vertex i + n j; i along x, j along z).
 * stay(i, j): cells that stay whole; skip(i, j): cells left out (they also stay whole around them: give them to stay too).
 * Returns { index (Uint32Array or Uint16Array), blocks: count of merged blocks by size, fans }.
 */
export function lighterGrid(positions, normals, n, { stay = () => false, skip = () => false, height = GROUND_LIGHTER.height,
  normalDeg = GROUND_LIGHTER.normalDeg, sizes = GROUND_LIGHTER.sizes } = {}) {
  const cells = n - 1, cos = Math.cos(normalDeg * Math.PI / 180)
  const at = (i, j) => i + n * j
  const pinned = new Uint8Array(cells * cells), left = new Uint8Array(cells * cells)
  for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) { left[i + cells * j] = skip(i, j) ? 1 : 0; pinned[i + cells * j] = left[i + cells * j] || stay(i, j) ? 1 : 0 }
  const banned = new Set()

  // The block's corner values (f00, f10, f01, f11, centre) of the height and the normal's three components.
  const fh = new Float64Array(5), fx = new Float64Array(5), fy = new Float64Array(5), fz = new Float64Array(5)
  const put = (k, v) => { v *= 3; fh[k] = positions[v + 1]; fx[k] = normals[v]; fy[k] = normals[v + 1]; fz[k] = normals[v + 2] }
  const load = (i0, j0, s) => { put(0, at(i0, j0)); put(1, at(i0 + s, j0)); put(2, at(i0, j0 + s)); put(3, at(i0 + s, j0 + s)); put(4, at(i0 + s / 2, j0 + s / 2)) }
  // Is the vertex w, given the height and normal drawn there, within the tolerances?
  const close = (w, h, x, y, z) => Math.abs(h - positions[w * 3 + 1]) <= height &&
    x * normals[w * 3] + y * normals[w * 3 + 1] + z * normals[w * 3 + 2] >= cos * Math.sqrt(x * x + y * y + z * z)
  // Does the loaded block, drawn in `form`, stay within at every vertex inside? (Heights first: they fail most often.)
  function within(i0, j0, s, form) {
    for (let j = 0; j <= s; j++) for (let i = 0; i <= s; i++)
      if (Math.abs(interpolate(fh, i / s, j / s, form) - positions[at(i0 + i, j0 + j) * 3 + 1]) > height) return false
    for (let j = 0; j <= s; j++) for (let i = 0; i <= s; i++) {
      const u = i / s, v = j / s
      if (!close(at(i0 + i, j0 + j), interpolate(fh, u, v, form), interpolate(fx, u, v, form), interpolate(fy, u, v, form), interpolate(fz, u, v, form))) return false
    }
    return true
  }
  // A fan from the centre through the given ring of boundary vertices ([i, j], in order around the block): within?
  function fanWithin(i0, j0, s, ring) {
    const mi = i0 + s / 2, mj = j0 + s / 2, vm = at(mi, mj)
    for (let j = j0; j <= j0 + s; j++) for (let i = i0; i <= i0 + s; i++) {
      for (let k = 0; k < ring.length; k++) {
        const [ai, aj] = ring[k], [bi, bj] = ring[(k + 1) % ring.length]
        // weights of (i, j) in the triangle (centre, a, b)
        const d = (ai - mi) * (bj - mj) - (bi - mi) * (aj - mj)
        const wa = ((i - mi) * (bj - mj) - (bi - mi) * (j - mj)) / d, wb = ((ai - mi) * (j - mj) - (i - mi) * (aj - mj)) / d, wm = 1 - wa - wb
        if (wa < -1e-9 || wb < -1e-9 || wm < -1e-9) continue
        const va = at(ai, aj) * 3, vb = at(bi, bj) * 3, c = vm * 3
        if (!close(at(i, j), wm * positions[c + 1] + wa * positions[va + 1] + wb * positions[vb + 1], wm * normals[c] + wa * normals[va] + wb * normals[vb],
          wm * normals[c + 1] + wa * normals[va + 1] + wb * normals[vb + 1], wm * normals[c + 2] + wa * normals[va + 2] + wb * normals[vb + 2])) return false
        break
      }
    }
    return true
  }

  for (let attempt = 0; ; attempt++) {
    // Merge bottom-up: a block merges when its four quarters did (its 2 x 2 cells for the smallest) and it is flat enough.
    const levels = []
    for (const s of sizes) {
      const nb = Math.floor(cells / s), ok = new Int8Array(nb * nb), below = levels.at(-1)
      for (let bj = 0; bj < nb; bj++) for (let bi = 0; bi < nb; bi++) {
        const i0 = bi * s, j0 = bj * s
        if (banned.size && banned.has(`${s}:${i0}:${j0}`)) continue
        if (below) { const q = below.nb, c = 2 * bi + q * 2 * bj; if (!(below.ok[c] && below.ok[c + 1] && below.ok[c + q] && below.ok[c + q + 1])) continue }
        else if (pinned[i0 + cells * j0] || pinned[i0 + 1 + cells * j0] || pinned[i0 + cells * (j0 + 1)] || pinned[i0 + 1 + cells * (j0 + 1)]) continue
        load(i0, j0, s)
        if (!within(i0, j0, s, FAN)) continue
        // the two-triangle form, used when no neighbour is finer: a diagonal that stays within (PlaneGeometry's first)
        ok[bi + nb * bj] = within(i0, j0, s, D1) ? D1 : within(i0, j0, s, D2) ? D2 : 0
      }
      levels.push({ s, nb, ok })
    }
    // The blocks drawn: merged, with an unmerged parent.
    const owner = new Uint8Array(cells * cells), leaves = []
    for (let l = levels.length - 1; l >= 0; l--) {
      const { s, nb, ok } = levels[l]
      for (let bj = 0; bj < nb; bj++) for (let bi = 0; bi < nb; bi++) {
        const i0 = bi * s, j0 = bj * s
        if (!ok[bi + nb * bj] || owner[i0 + cells * j0]) continue
        leaves.push({ s, i0, j0, diagonal: ok[bi + nb * bj] })
        for (let j = 0; j < s; j++) owner.fill(1, i0 + cells * (j0 + j), i0 + s + cells * (j0 + j))
      }
    }
    const used = new Uint8Array(n * n)
    const mark = (i0, j0, s) => { used[at(i0, j0)] = used[at(i0 + s, j0)] = used[at(i0, j0 + s)] = used[at(i0 + s, j0 + s)] = 1 }
    for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) if (!owner[i + cells * j] && !left[i + cells * j]) mark(i, j, 1)
    for (const { s, i0, j0 } of leaves) mark(i0, j0, s)

    // At most the full grid's triangles: a fan around a block of s x s cells has at most 4 s <= 2 s^2.
    const out = new Uint32Array(cells * cells * 6), blocks = {}
    let count = 0, fans = 0, failed = 0
    const triangle = (a, b, c) => { out[count++] = a; out[count++] = b; out[count++] = c }
    for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) {
      if (owner[i + cells * j] || left[i + cells * j]) continue
      const a = at(i, j), b = at(i, j + 1), c = at(i + 1, j + 1), d = at(i + 1, j)
      triangle(a, b, d); triangle(b, c, d)                                               // as PlaneGeometry
    }
    for (const leaf of leaves) {
      const { s, i0, j0, diagonal } = leaf
      blocks[s] = (blocks[s] ?? 0) + 1
      const a = at(i0, j0), b = at(i0, j0 + s), c = at(i0 + s, j0 + s), d = at(i0 + s, j0)
      let inner = 0                                                                      // vertices finer neighbours use on its edges
      for (let k = 1; k < s; k++) inner += used[at(i0 + k, j0)] + used[at(i0 + s, j0 + k)] + used[at(i0 + k, j0 + s)] + used[at(i0, j0 + k)]
      if (!inner) { if (diagonal === D1) { triangle(a, b, d); triangle(b, c, d) } else { triangle(a, b, c); triangle(a, c, d) } continue }
      const ring = []
      for (let k = 0; k < s; k++) ring.push([i0 + k, j0])
      for (let k = 0; k < s; k++) ring.push([i0 + s, j0 + k])
      for (let k = 0; k < s; k++) ring.push([i0 + s - k, j0 + s])
      for (let k = 0; k < s; k++) ring.push([i0, j0 + s - k])
      const kept = ring.filter(p => used[at(...p)])
      // finer neighbours: a fan from the centre; checked again with the vertices it really goes through
      if (!fanWithin(i0, j0, s, kept)) { banned.add(`${s}:${i0}:${j0}`); failed++; continue }
      fans++
      const m = [i0 + s / 2, j0 + s / 2]
      for (let k = 0; k < kept.length; k++) {
        const p = kept[k], q = kept[(k + 1) % kept.length]
        const turn = (p[0] - m[0]) * (q[1] - m[1]) - (q[0] - m[0]) * (p[1] - m[1])        // PlaneGeometry's faces turn negative in (i, j)
        if (turn < 0) triangle(at(...m), at(...p), at(...q)); else triangle(at(...m), at(...q), at(...p))
      }
    }
    if (failed && attempt < 6) continue                                                  // rebuild without the blocks that failed
    const index = n * n > 65535 ? out.slice(0, count) : Uint16Array.from(out.subarray(0, count))
    return { index, blocks, fans, attempts: attempt + 1 }
  }
}

/** The two noises at the grid's vertices, as a two-channel texture's data: row r = the vertices at Blender y = y0 + r dy
 *  (three z = -y), column i = x0 + i dx: the layout of the terrain's other maps, one texel per vertex. */
export function groundNoiseData(n, x0, y0, dx, dy) {
  const data = new Float32Array(n * n * 2)
  for (let r = 0; r < n; r++) for (let i = 0; i < n; i++) {
    const [soil, tint] = groundNoise(x0 + i * dx, -(y0 + r * dy))
    data[(i + n * r) * 2] = soil; data[(i + n * r) * 2 + 1] = tint
  }
  return data
}

/** World (three) x, z -> the height map's bilinear height, clamped at its borders. data.js samples with it on the
 *  main thread, buildGround in the ground worker. heights: R x R metres, row 0 = Blender y0 (three z = -y0). */
export function heightSampler(heights, R, { x0, x1, y0, y1 }) {
  const clamp01 = v => Math.max(0, Math.min(1, v))
  return (x, z) => {
    const fx = clamp01((x - x0) / (x1 - x0)) * (R - 1), fy = clamp01((-z - y0) / (y1 - y0)) * (R - 1)
    const i = Math.min(R - 2, Math.floor(fx)), j = Math.min(R - 2, Math.floor(fy)), tx = fx - i, ty = fy - j
    const h00 = heights[j * R + i], h10 = heights[j * R + i + 1], h01 = heights[(j + 1) * R + i], h11 = heights[(j + 1) * R + i + 1]
    return (h00 * (1 - tx) + h10 * tx) * (1 - ty) + (h01 * (1 - tx) + h11 * tx) * ty
  }
}

// x, y, z through a three.js Matrix4 (column-major elements), in three's own order of operations (Vector3.applyMatrix4).
const apply = (e, x, y, z) => {
  const w = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15])
  return [(e[0] * x + e[4] * y + e[8] * z + e[12]) * w, (e[1] * x + e[5] * y + e[9] * z + e[13]) * w, (e[2] * x + e[6] * y + e[10] * z + e[14]) * w]
}

/** The ground grid as Terrain.jsx used to build it with three on the main thread, number for number, without three,
 *  so a worker builds it while the loading screen keeps moving (ground.worker.js; about 100 ms of the main thread on
 *  the test laptop, more on a slow processor). groundMesh.test.js checks it against three.
 *    the grid: PlaneGeometry (positions, uvs) over the terrain bounds, 255 x 255 cells, turned flat and moved over the terrain, each
 *              vertex lifted to the height map, then three's computeVertexNormals (float32 at every step, as three);
 *    index:    the lighter triangle list (lighterGrid), with the cells under deep water and inside the island's
 *              shore box left out; with `legacy` (development, ?groundLegacy) the full grid's;
 *    noise:    the two colour noises at the vertices (groundNoiseData), or null with `legacy`. */
export function buildGround({ heights, R, bounds, shoreBox = null, water, legacy = false }) {
  const { x0, x1, y0, y1 } = bounds, seg = 255, n = seg + 1, width = x1 - x0, height = y1 - y0
  const dx = width / seg, dy = height / seg, heightAt = heightSampler(heights, R, bounds)
  // PlaneGeometry(width, height, seg, seg): vertex (x, -y, 0) row by row from the top, then rotateX(-PI / 2) and
  // translate to the bounds' centre, each a Matrix4 applied as three applies it.
  const c = Math.cos(-Math.PI / 2), s = Math.sin(-Math.PI / 2)
  const rotate = [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1], move = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, (x0 + x1) / 2, 0, -(y0 + y1) / 2, 1]
  const positions = new Float32Array(n * n * 3), uvs = new Float32Array(n * n * 2), f = new Float32Array(3)
  for (let iy = 0, k = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++, k += 3) {
    f[0] = ix * (width / seg) - width / 2; f[1] = -(iy * (height / seg) - height / 2); f[2] = 0
    ;[f[0], f[1], f[2]] = apply(rotate, f[0], f[1], f[2]); [f[0], f[1], f[2]] = apply(move, f[0], f[1], f[2])
    positions[k] = f[0]; positions[k + 2] = f[2]; positions[k + 1] = heightAt(positions[k], positions[k + 2])
    uvs[k / 3 * 2] = ix / seg; uvs[k / 3 * 2 + 1] = 1 - iy / seg            // the normal map's derivatives read them
  }
  const plane = new Uint32Array(seg * seg * 6)
  for (let iy = 0, k = 0; iy < seg; iy++) for (let ix = 0; ix < seg; ix++) {
    const a = ix + n * iy, b = ix + n * (iy + 1), cc = ix + 1 + n * (iy + 1), d = ix + 1 + n * iy
    plane.set([a, b, d, b, cc, d], k); k += 6
  }
  // computeVertexNormals: each triangle's (C - B) x (A - B) added to its three vertices (stored as float32 after each
  // addition), then every normal scaled to length 1.
  const normals = new Float32Array(n * n * 3), p = positions
  for (let t = 0; t < plane.length; t += 3) {
    const A = plane[t] * 3, B = plane[t + 1] * 3, C = plane[t + 2] * 3
    const cbx = p[C] - p[B], cby = p[C + 1] - p[B + 1], cbz = p[C + 2] - p[B + 2], abx = p[A] - p[B], aby = p[A + 1] - p[B + 1], abz = p[A + 2] - p[B + 2]
    const nx = cby * abz - cbz * aby, ny = cbz * abx - cbx * abz, nz = cbx * aby - cby * abx
    for (const v of [A, B, C]) { normals[v] += nx; normals[v + 1] += ny; normals[v + 2] += nz }
  }
  for (let v = 0; v < normals.length; v += 3) {
    const x = normals[v], y = normals[v + 1], z = normals[v + 2], scale = 1 / (Math.sqrt(x * x + y * y + z * z) || 1)
    normals[v] = x * scale; normals[v + 1] = y * scale; normals[v + 2] = z * scale
  }
  if (legacy) return { positions, normals, uvs, index: plane, noise: null }
  // Cell (i, j) spans x0 + i dx .. and Blender y y1 - j dy .. down (the grid's rows run from y1 to y0).
  const band = GROUND_LIGHTER.waterBand
  const inBox = (i, j) => { if (!shoreBox) return false; const x = x0 + (i + .5) * dx, y = y1 - (j + .5) * dy; return x > shoreBox[0] && x < shoreBox[1] && y > shoreBox[2] && y < shoreBox[3] }
  const nearBox = (i, j) => inBox(i, j) || inBox(i - 1, j) || inBox(i + 1, j) || inBox(i, j - 1) || inBox(i, j + 1)
  // Near the waterline the water's edge would move with the ground: those cells stay whole.
  const nearWater = (i, j) => {
    const a = p[(i + n * j) * 3 + 1], b = p[(i + 1 + n * j) * 3 + 1], cc = p[(i + n * j + n) * 3 + 1], d = p[(i + 1 + n * j + n) * 3 + 1]
    return Math.min(a, b, cc, d) <= water + band && Math.max(a, b, cc, d) >= water - band     // a corner in the band, or the cell across it
  }
  // Under deep water the pond is opaque (Pond.jsx: from 2.5 cm) and the camera stays above the surface, so the ground
  // there is never seen, yet it was shaded before the water covered it: 0.7 ms in the main view on the Intel laptop.
  // Cells lying 12 cm or more under the surface all over (5 x 5 points, the pond's own depth source) are left out;
  // the water writes its own depth, so the mist in front of it is unchanged.
  const underWater = (i, j) => {
    for (let b = 0; b <= 4; b++) for (let a = 0; a <= 4; a++) if (heightAt(x0 + (i + a / 4) * dx, -y1 + (j + b / 4) * dy) >= water - band) return false
    return true
  }
  const { index } = lighterGrid(positions, normals, n, { stay: (i, j) => nearBox(i, j) || nearWater(i, j), skip: (i, j) => inBox(i, j) || underWater(i, j) })
  return { positions, normals, uvs, index, noise: groundNoiseData(n, x0, y0, dx, dy) }
}
