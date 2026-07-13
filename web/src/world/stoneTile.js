import * as THREE from 'three/webgpu'
import { fetchOk } from './bytes.js'
import { abs, exp2, float, max, min, mix, normalWorld, normalize, positionWorld, texture, uv, vec2, vec3 } from 'three/tsl'
import { STONE_LEGACY, legacySurface, loadLegacyStone } from './stoneLegacy.js'

// The statue's stone (blender/scripts/stone_tile.py, pack_head_macro.py), two scales of relief so neither repeats:
//   macro   the head's own colour, 1024 px in its UVs: stains, rain streaks, lichen, moss, with the crevice occlusion
//           and the mouth line already multiplied in
//   relief  the head's own coarse relief (weathering pits and hollows, 1-30 cm), in its UVs: how far the normal turns,
//           in world axes (1024; phones 512); its alpha calms the tile's crevices on and around the mouth line
//   tile    one repeating patch of fine rock relief (Poly Haven rock_surface, CC0), 2 m over 1024 px (2 mm a texel; phones 512),
//           applied from the three world axes so the head's scattered UV islands do not matter. It arrives as one grey
//           height image; here, once, it becomes one RGBA texture:
//             R, G  the surface's tilt along the tile's u and v (0.5 = flat)   B  height
//             A     height relative to its surroundings (crevices low, crests high), which shades the colour: no colour
//                   image needs to ship
const CAVITY_RADIUS_M = .012     // crevices and crests narrower than about this

async function pixels(path, size) {
  const r = await fetchOk('/' + path, { label: 'Stone texture' })
  const bitmap = await createImageBitmap(await r.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
  const canvas = new OffscreenCanvas(size, size), ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0, size, size)
  bitmap.close()
  return ctx.getImageData(0, 0, size, size).data
}

// Running box mean along rows (along = 0) or columns (1), wrapping, so the tile stays seamless. Columns keep one running
// sum per column and walk down the rows, so memory is read in order.
function boxMean(src, size, r, along) {
  const out = new Float32Array(size * size), n = 2 * r + 1
  if (!along) {
    for (let base = 0; base < size * size; base += size) {
      let sum = 0
      for (let i = -r; i <= r; i++) sum += src[base + (i + size) % size]
      for (let i = 0; i < size; i++) {
        out[base + i] = sum / n
        sum += src[base + (i + r + 1) % size] - src[base + (i - r + size) % size]
      }
    }
    return out
  }
  const sum = new Float32Array(size)
  for (let i = -r; i <= r; i++) { const row = ((i + size) % size) * size; for (let x = 0; x < size; x++) sum[x] += src[row + x] }
  for (let y = 0; y < size; y++) {
    const row = y * size, add = ((y + r + 1) % size) * size, drop = ((y - r + size) % size) * size
    for (let x = 0; x < size; x++) { out[row + x] = sum[x] / n; sum[x] += src[add + x] - src[drop + x] }
  }
  return out
}

export function buildTile(height, size, entry) {
  // clamped array: each store rounds and clamps to 0..255 by itself
  const data = new Uint8ClampedArray(size * size * 4), k = entry.height_slope * size / 512 / 255 / 2 * 127.5
  const hgt = new Float32Array(size * size)
  for (let i = 0; i < size * size; i++) hgt[i] = height[i * 4]
  const r = Math.max(1, Math.round(CAVITY_RADIUS_M / entry.tile_m * size))
  const mean = boxMean(boxMean(boxMean(boxMean(hgt, size, r, 0), size, r, 1), size, r, 0), size, r, 1)
  let rms = 0
  for (let i = 0; i < size * size; i++) rms += (hgt[i] - mean[i]) ** 2
  const toUnits = 32 / (Math.sqrt(rms / (size * size)) || 1)
  for (let y = 0; y < size; y++) {
    const row = y * size, up = ((y + size - 1) % size) * size, down = ((y + 1) % size) * size
    for (let x = 0; x < size; x++) {
      const left = (x + size - 1) % size, right = (x + 1) % size, j = row + x, i = j * 4
      // tilt = -slope of the height along the tile's u (columns) and v (rows); stored as 0.5 + tilt / 2
      const a = -(hgt[row + right] - hgt[row + left]) * k, b = -(hgt[down + x] - hgt[up + x]) * k
      data[i] = 127.5 + a
      data[i + 1] = 127.5 + b
      data[i + 2] = hgt[j]
      data[i + 3] = 128 + (hgt[j] - mean[j]) * toUnits   // +-4 standard deviations
    }
  }
  return new Uint8Array(data.buffer)
}

function mapTexture(texture, colorSpace) {
  texture.colorSpace = colorSpace
  texture.flipY = false                               // baked in the head's glTF UVs
  texture.anisotropy = 4; texture.userData.sharedWorld = true
  return texture
}

export async function loadHeadStone(entry, low = false) {
  if (STONE_LEGACY) return loadLegacyStone(pixels, low)
  const size = low ? 512 : 1024
  const tile = new THREE.DataTexture(buildTile(await pixels(low ? entry.tile_low : entry.tile, size), size, entry), size, size, THREE.RGBAFormat)
  tile.wrapS = tile.wrapT = THREE.RepeatWrapping
  tile.magFilter = THREE.LinearFilter; tile.minFilter = THREE.LinearMipmapLinearFilter
  tile.generateMipmaps = true; tile.anisotropy = 8; tile.colorSpace = THREE.NoColorSpace
  tile.needsUpdate = true; tile.userData.sharedWorld = true
  const loader = new THREE.TextureLoader()
  const [macro, relief] = await Promise.all([loader.loadAsync('/' + (low && entry.macro_low || entry.macro)),
    loader.loadAsync('/' + (low && entry.relief_map_low || entry.relief_map))])
  return { macro: mapTexture(macro, THREE.SRGBColorSpace), relief: mapTexture(relief, THREE.NoColorSpace), tile, params: entry }
}

// Colour, occlusion, normal (world) and roughness of the stone at this pixel.
// The head's coarse relief turns the normal first; the tile's fine relief then rides on it. Triplanar: the tile is
// projected along x, y and z (each shifted, so the three never line up) and the three are blended by how squarely the
// surface faces each axis. The tile's tilt is added to the normal in each projection's own frame (u along the first
// world axis named, v along the second), so the relief lights correctly whatever the face's direction.
export function stoneSurface(stone) {
  if (stone.legacy) return legacySurface(stone)
  const { macro, relief, tile, params } = stone
  const n0 = normalize(normalWorld)
  const coarse = texture(relief, uv())             // rgb: the coarse normal turn; a: tile crevices on (1) or calmed (0, mouth line)
  const n = normalize(n0.add(coarse.rgb.mul(2).sub(1).mul(params.coarse_range)))
  const p = positionWorld.div(params.tile_m)
  let w = abs(n0).pow(4); w = w.div(w.x.add(w.y).add(w.z))
  // The shifts are chosen so that no long crack of the tile lies on the chin just under the mouth line, where it read as a
  // second line (searched over the head's own texels, 2026-11-17)
  const sx = texture(tile, vec2(p.z, p.y).add(vec2(.45, .45))), sy = texture(tile, vec2(p.x, p.z).add(vec2(.53, .11)))
  const sz = texture(tile, vec2(p.x, p.y).add(vec2(.3, .5)))
  const tilt = s => s.xy.mul(2).sub(1).mul(params.relief)
  const ax = tilt(sx), ay = tilt(sy), az = tilt(sz)
  const normal = normalize(
    vec3(n.x, n.y.add(ax.y), n.z.add(ax.x)).mul(w.x)
      .add(vec3(n.x.add(ay.x), n.y, n.z.add(ay.y)).mul(w.y))
      .add(vec3(n.x.add(az.x), n.y.add(az.y), n.z).mul(w.z)))
  const blend = (a, b, c) => a.mul(w.x).add(b.mul(w.y)).add(c.mul(w.z))
  const height = blend(sx.z, sy.z, sz.z)
  // c: height relative to the surroundings, in standard deviations. Only the deeper crevices darken (by `cavity` stops
  // per deviation past 0.35) and only the higher crests pale (worn edges): the stone between stays calm, so the mouth
  // line and the other painted forms keep reading.
  const c = blend(sx.w, sy.w, sz.w).sub(128 / 255).mul(255 / 32)
  const albedo = texture(macro, uv()).rgb.mul(exp2(min(c.add(.35), 0).mul(coarse.a).mul(params.cavity).add(max(c.sub(.6), 0).mul(params.cavity * .25))))
  const roughness = mix(float(params.roughness[1]), float(params.roughness[0]), height)
  return { albedo, occlusion: float(1), normal, roughness }
}
