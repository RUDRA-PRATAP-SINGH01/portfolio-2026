import * as THREE from 'three/webgpu'
import { abs, exp2, float, mix, normalWorld, normalize, positionWorld, texture, uv, vec2, vec3 } from 'three/tsl'

// ?stoneLegacy (development): the statue's stone as it was before 2026-11-17, for A/B comparisons. One unique map with
// the occlusion in its alpha (head_macro_*), and the rock_3 tile as relief + colour grain, 512 px over 1.4 m.
export const STONE_LEGACY = !!(import.meta.env?.DEV && typeof location !== 'undefined' && new URLSearchParams(location.search).has('stoneLegacy'))

const ENTRY = {
  macro: 'cinematic/head_macro_1024.webp', macro_low: 'cinematic/head_macro_512.webp',
  height: 'cinematic/stone_height_512.webp', grain: 'cinematic/stone_grain_384.webp',
  tile_m: 1.4, relief: 1.6, grain_strength: .75, roughness: [.8, .95], height_slope: 10.7,
}

export async function loadLegacyStone(pixels, low) {
  const entry = ENTRY, size = 512
  const [height, grain] = await Promise.all([pixels(entry.height, size), pixels(entry.grain, size)])
  const data = new Uint8Array(size * size * 4), k = entry.height_slope * size / 512 / 255 / 2
  const h = (x, y) => height[(((y + size) % size) * size + (x + size) % size) * 4]
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = -(h(x + 1, y) - h(x - 1, y)) * k, b = -(h(x, y + 1) - h(x, y - 1)) * k, i = (y * size + x) * 4
      data[i] = Math.max(0, Math.min(255, Math.round(127.5 + a * 127.5)))
      data[i + 1] = Math.max(0, Math.min(255, Math.round(127.5 + b * 127.5)))
      data[i + 2] = height[i]
      data[i + 3] = grain[i]
    }
  }
  const tile = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
  tile.wrapS = tile.wrapT = THREE.RepeatWrapping
  tile.magFilter = THREE.LinearFilter; tile.minFilter = THREE.LinearMipmapLinearFilter
  tile.generateMipmaps = true; tile.anisotropy = 8; tile.colorSpace = THREE.NoColorSpace
  tile.needsUpdate = true; tile.userData.sharedWorld = true
  const macro = await new THREE.TextureLoader().loadAsync('/' + (low ? entry.macro_low : entry.macro))
  macro.colorSpace = THREE.SRGBColorSpace
  macro.flipY = false
  macro.anisotropy = 4; macro.userData.sharedWorld = true
  return { macro, tile, params: entry, legacy: true }
}

export function legacySurface({ macro, tile, params }) {
  const m = texture(macro, uv())
  const p = positionWorld.div(params.tile_m), n = normalize(normalWorld)
  let w = abs(n).pow(4); w = w.div(w.x.add(w.y).add(w.z))
  const sx = texture(tile, vec2(p.z, p.y)), sy = texture(tile, vec2(p.x, p.z)), sz = texture(tile, vec2(p.x, p.y))
  const tilt = s => s.xy.mul(2).sub(1).mul(params.relief)
  const ax = tilt(sx), ay = tilt(sy), az = tilt(sz)
  const normal = normalize(
    vec3(n.x, n.y.add(ax.y), n.z.add(ax.x)).mul(w.x)
      .add(vec3(n.x.add(ay.x), n.y, n.z.add(ay.y)).mul(w.y))
      .add(vec3(n.x.add(az.x), n.y.add(az.y), n.z).mul(w.z)))
  const blend = (a, b, c) => a.mul(w.x).add(b.mul(w.y)).add(c.mul(w.z))
  const height = blend(sx.z, sy.z, sz.z), grain = blend(sx.w, sy.w, sz.w)
  const albedo = m.rgb.mul(exp2(grain.sub(.5).mul(4 * params.grain_strength)))
  const roughness = mix(float(params.roughness[1]), float(params.roughness[0]), height)
  return { albedo, occlusion: m.a, normal, roughness }
}
