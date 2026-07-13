import * as THREE from 'three/webgpu'
import { loadCinematic, ktx2Loader } from './cinematic.js'
import { loadPbr } from './pbr.js'
import { loadSky } from './sky.js'
import { loadWater } from './water.js'
import { download, fetchOk } from './bytes.js'
import { heightSampler } from './groundMesh.js'
import { loadCameraPath } from './cameraPath.js'
import { TEXTURES_LOW } from '../quality.js'
import { LATE, upgradeTexture } from './lateTextures.js'

// Loads the Blender export (blender/scripts/mf_export_web.py):
//   terrain_height.u16  - 16-bit heights, normalised to [height_min, height_max]
//   terrain_data.rgba8  - R grass density, G moonlight through canopy, B water depth, A wetness
// Texel layout: row 0 = Blender y0 (three z = -y0), column 0 = x0.
export async function loadWorldData(base = '/data/', onProgress = () => {}) {
  const meta = await (await fetchOk(base + 'scene_meta.json')).json()
  // The scene's colours and light strengths (palette.json). In development ?palette=<name> lays
  // palette_<name>.json over it, to compare variants of the colour balance without touching the default.
  const palette = await (await fetchOk(base + 'palette.json')).json()
  const variant = import.meta.env.DEV && new URLSearchParams(location.search).get('palette')
  if (variant && /^[\w-]+$/.test(variant)) overlay(palette, await (await fetchOk(`${base}palette_${variant}.json`)).json())
  // moon.gain: the moon as the browser lights with it, relative to Blender's (direct light only; its bounce is
  // bake.moonBounce). A stronger key light is what separates lit from shadowed.
  meta.moon.strength *= palette.moon.gain
  onProgress(.06)
  // In development ?sceneVariant=<folder> loads scene/<folder>/scene.json (an earlier export kept beside the current
  // one), to compare plants before and after a change of their meshes.
  const sceneVariant = import.meta.env.DEV && new URLSearchParams(location.search).get('sceneVariant')
  const sceneFile = meta.scene && (sceneVariant && /^[\w-]+$/.test(sceneVariant) ? meta.scene.file.replace(/[^/]+$/, name => `${sceneVariant}/${name}`) : meta.scene.file)
  const sceneManifest = sceneFile ? await (await fetchOk('/' + sceneFile)).json() : null
  onProgress(.15)
  const look = await (await fetchOk(base + 'agx_punchy_lut.json')).json()
  const lookBytes = await download('/' + look.file)
  if (lookBytes.byteLength !== look.size ** 3 * 8) throw new Error('Invalid Blender display LUT')
  const lookTexture = new THREE.Data3DTexture(new Uint16Array(lookBytes), look.size, look.size, look.size)
  lookTexture.type = THREE.HalfFloatType
  lookTexture.colorSpace = THREE.NoColorSpace
  lookTexture.generateMipmaps = false
  lookTexture.minFilter = lookTexture.magFilter = THREE.LinearFilter
  lookTexture.needsUpdate = true
  onProgress(.36)
  const groundTextures = {}
  // the forest floor's litter: UASTC 1024 on desktops, phones the lighter `ground_low` (pack_browser_scene.py); desktops
  // show `ground_low` until the scene is up, then take the 1024 maps (lateTextures.js)
  const lateGround = LATE && sceneManifest?.ground_low
  const ground = (TEXTURES_LOW || lateGround) && sceneManifest?.ground_low || sceneManifest?.ground
  if (ground) {
    const loader = new THREE.TextureLoader()
    const compressed = Object.values(ground).some(url => url.endsWith('.ktx2')) ? await ktx2Loader() : null
    let loaded = 0
    await Promise.all(Object.entries(ground).map(async ([key, url]) => {
      const image = await (url.endsWith('.ktx2') ? compressed : loader).loadAsync('/' + url)
      image.colorSpace = key === 'base' ? THREE.SRGBColorSpace : THREE.NoColorSpace
      image.wrapS = image.wrapT = THREE.RepeatWrapping; image.anisotropy = 8
      groundTextures[key] = image
      if (lateGround && sceneManifest.ground[key] !== url) upgradeTexture(image, '/' + sceneManifest.ground[key])
      onProgress(.36 + .20 * (++loaded / Object.keys(ground).length))
    }))
  }
  const T = meta.terrain
  const R = T.resolution
  const [x0, x1, y0, y1] = T.bounds_blender_xy

  const raw16 = new Uint16Array(await download('/' + T.height_file))
  const heights = new Float32Array(R * R)
  const half = new Uint16Array(R * R)
  const span = T.height_max - T.height_min
  for (let i = 0; i < R * R; i++) {
    heights[i] = T.height_min + (raw16[i] / 65535) * span
    half[i] = THREE.DataUtils.toHalfFloat(heights[i])
  }
  const heightTexture = new THREE.DataTexture(half, R, R, THREE.RedFormat, THREE.HalfFloatType)
  heightTexture.magFilter = THREE.LinearFilter
  heightTexture.minFilter = THREE.LinearFilter
  heightTexture.needsUpdate = true
  onProgress(.8)

  const rgba = new Uint8Array(await download('/' + T.data_file))
  const dataTexture = new THREE.DataTexture(rgba, R, R, THREE.RGBAFormat, THREE.UnsignedByteType)
  dataTexture.magFilter = THREE.LinearFilter
  dataTexture.minFilter = THREE.LinearFilter
  dataTexture.needsUpdate = true
  // The statue island's shoreline is finer than this grid can carry (blender/scripts/mf_shore.py): inside its box
  // the ground is a separate light mesh: float32 xyz, float32 normals (three.js axes), float32 moss cover, then
  // uint16 triangle indices.
  let shore = null
  if (T.shore) {
    const bytes = await download('/' + T.shore.file), v = T.shore.vertices, n = v * 3
    shore = { box: T.shore.box_blender_xy, positions: new Float32Array(bytes, 0, n), normals: new Float32Array(bytes, n * 4, n),
              moss: new Float32Array(bytes, n * 8, v), index: new Uint16Array(bytes, n * 8 + v * 4, T.shore.triangles * 3) }
  }
  const cinematic = await loadCinematic(meta.cinematic, value => onProgress(.85 + value*.1))
  const pbr = await loadPbr(meta.pbr, value => onProgress(.95 + value*.05))
  const sky = await loadSky(palette.sky?.file ? { file: palette.sky.file } : meta.sky)   // a palette variant may bring its own sky
  const water = await loadWater(meta.water)
  const cameraPath = await loadCameraPath()             // the scroll camera's path (cameraPath.js; ?orbit leaves it unused)
  // The statue: where it stands and the middle of its head (the mesh is 3.46 m tall at scale 1), for effects centred
  // on it. Its matrix carries its size (2026-11-15: 1.25).
  const M = meta.moai?.matrix, stand = M ? new THREE.Vector3(M[12], M[13], M[14]) : null, size = M ? Math.hypot(M[0], M[1], M[2]) : 1
  const statue = stand && { base: stand, centre: new THREE.Vector3(stand.x + .22 * size, stand.y + 1.75 * size, stand.z + .17 * size), radius: 1.35 * size, height: 3.7 * size }
  onProgress(1)

  // CPU sampling (bilinear): for the terrain mesh, pointer picking, camera clamping (the ground worker uses the same).
  const heightAt = heightSampler(heights, R, { x0, x1, y0, y1 })

  return {
    meta, palette, sceneManifest, groundTextures, cinematic, pbr, sky, water, statue, cameraPath, look: { ...look, texture: lookTexture },
    bounds: { x0, x1, y0, y1 },
    // world (three) -> data UV: u = (x - x0)/(x1 - x0), v = (-z - y0)/(y1 - y0)
    uvScale: new THREE.Vector2(1 / (x1 - x0), -1 / (y1 - y0)),
    uvOffset: new THREE.Vector2(-x0 / (x1 - x0), -y0 / (y1 - y0)),
    heights, resolution: R, heightTexture, dataTexture, heightAt, shore,
  }
}

// Lays the values of `over` on `base`, group by group; lists (colours, ranges) are replaced whole.
function overlay(base, over) {
  for (const [key, value] of Object.entries(over)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object') overlay(base[key], value)
    else base[key] = value
  }
  return base
}

// three.js colour from a linear [r,g,b] array
export const lin = (c) => new THREE.Color().setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace)
