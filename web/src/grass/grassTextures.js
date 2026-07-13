import * as THREE from 'three/webgpu'

// Small lookup textures generated at startup (no downloads).
// Albedo LUT: x = per-blade variation, y = height along the blade (0 root .. 1 tip). Linear colour.
// variants: linear tints mixed across x (palette.json grass.variants: bluish, base, yellow-green, near-black).
export function makeAlbedoLUT(rootColor, tipColor, variants, w = 64, h = 256) {
  const data = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    const t = y / (h - 1)
    const s = t * t * (3 - 2 * t)
    for (let x = 0; x < w; x++) {
      const v = (x / (w - 1)) * (variants.length - 1)
      const a = Math.floor(v), b = Math.min(variants.length - 1, a + 1), f = v - a
      const tint = [0, 1, 2].map((k) => variants[a][k] * (1 - f) + variants[b][k] * f)
      for (let k = 0; k < 3; k++) {
        const c = (rootColor[k] * (1 - s) + tipColor[k] * s) * tint[k]
        data[(y * w + x) * 4 + k] = Math.min(255, Math.round(Math.sqrt(c) * 255))   // stored sqrt-encoded for precision in the darks
      }
      data[(y * w + x) * 4 + 3] = 255
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType)
  tex.magFilter = tex.minFilter = THREE.LinearFilter
  tex.needsUpdate = true
  return tex
}

// Value noise (two octaves, 0.65 / 0.35) for slow moving sheen patches. Repeat-wrapped.
export function makeNoiseTexture(size = 128, seed = 7) {
  let s = seed >>> 0
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
  const grid = (n) => { const g = new Float32Array(n * n); for (let i = 0; i < g.length; i++) g[i] = rnd(); return g }
  const g1 = grid(8), g2 = grid(32)
  const sample = (g, n, x, y) => {
    const fx = x * n, fy = y * n, ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy
    const sm = (t) => t * t * (3 - 2 * t)
    const at = (i, j) => g[((j % n) + n) % n * n + (((i % n) + n) % n)]
    const a = at(ix, iy), b = at(ix + 1, iy), c = at(ix, iy + 1), d = at(ix + 1, iy + 1)
    return (a + (b - a) * sm(tx)) * (1 - sm(ty)) + (c + (d - c) * sm(tx)) * sm(ty)
  }
  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const v = 0.65 * sample(g1, 8, x / size, y / size) + 0.35 * sample(g2, 32, x / size, y / size)
    const i = (y * size + x) * 4
    data[i] = data[i + 1] = data[i + 2] = Math.round(v * 255); data[i + 3] = 255
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.magFilter = tex.minFilter = THREE.LinearFilter
  tex.needsUpdate = true
  return tex
}
