import * as THREE from 'three/webgpu'
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js'
import { dot, length, mix, normalWorld, positionWorld, smoothstep, texture, texture3D, uniform, uv, vec2, vec3 } from 'three/tsl'
import { TEXTURES_LOW } from '../quality.js'
import { download, fetchOk } from './bytes.js'
import { loadHeadStone } from './stoneTile.js'
import { PBR_LEGACY } from './pbrLegacy.js'
import { LATE, upgradeTexture } from './lateTextures.js'

let rendererResolve
export const rendererReady = new Promise(resolve => { rendererResolve = resolve })
export const registerRenderer = renderer => rendererResolve(renderer)

// One KTX2 loader for the visit, with three's own Basis transcoder (the build gives it a hashed name, so it is
// cached for good). A loader per batch fetched and compiled the transcoder once per batch: three times a visit.
let ktx2 = null
export async function ktx2Loader() {
  const renderer = await rendererReady
  return (ktx2 ??= new KTX2Loader().setWorkerLimit(2).detectSupport(renderer))
}

// The baked light of the scene (blender/scripts/bake_cinematic.py, mixed and packed by pack_cinematic.py).
// Nothing here is lit by a live light; only the statue adds its own lamps and the moon (Moai.jsx).
//   maps        light maps, RGBM: terrain (world xz), rocks / wood_hero / wood_bg (their atlas, uv1), head (uv).
//               They hold the lamps, the sky and the moon's bounce. Direct moonlight is added by the surface's
//               own normal (bakedMaterial.js), times the share of the moon that reaches the point:
//   ground      R the ground's contact occlusion, G the moon's reach, B the sky's reach, over the terrain (world xz)
//   headReach   the reach of the statue's four live lights: key, rim, fill, moon
//   stone       the statue's stone: two small unique maps and a repeating relief tile (stoneTile.js)
//   fields      the light grid, light arriving from +x, -x, +y, -y, +z, -z, for everything without a map:
//               `ground` = lamps + sky (plants, grass, lily pads: they take the moon from `ground` G),
//               `canopy` = the same plus the moon (twigs up in the crowns),
//               `lamps`  = the lamps alone (grass: it has its own sky term, shaded by `ground` B);
//               `lamp` keeps the lamps alone as plain numbers, for the leaf cards (TreeSystem.js)
export async function loadCinematic(entry, progress) {
  if (!entry) return null
  const manifest = await (await fetchOk('/' + entry.file, { label: 'Lighting asset' })).json()
  if (manifest.version !== 2) throw new Error('Unsupported cinematic lighting export')
  // The tiling ground textures: phones take the 512 set (only the soil colour is smaller, 0.3 MB instead of 1.3;
  // its texels are still finer than a phone shows them), and the statue's 512 map.
  const tier = TEXTURES_LOW ? 'low' : 'high', surfaces = {}, maps = {}
  const loader = await ktx2Loader()
  const imageLoader = new THREE.TextureLoader()
  const lightMaps = ['terrain', 'rocks', 'wood_hero', 'wood_bg', 'head']
  // The soil's roughness map is not loaded: all but a few of its texels lie under the ground's lowest roughness
  // (Terrain.jsx), so a constant draws the same.
  const surfaceMaps = Object.entries(manifest.surfaces).filter(([key]) => key !== 'soil_roughness' || PBR_LEGACY.has('unused'))
  let done = 0; const count = surfaceMaps.length + lightMaps.length + 5 + (manifest.head_stone ? 1 : 0)
  const tick = () => progress(++done / count)
  // 8x anisotropy, as the litter beside them (data.js): the ground is mostly seen at grazing angles (5-12 degrees on
  // the camera path), where 4x left the soil blurrier than the litter.
  await Promise.all(surfaceMaps.map(async ([key, urls]) => {
    // a desktop map with a smaller phone file shows that one until the scene is up (lateTextures.js)
    const late = LATE && urls.low && urls.low !== urls[tier]
    const t = await loader.loadAsync('/' + urls[late ? 'low' : tier]); t.anisotropy = PBR_LEGACY.has('aniso') ? 4 : 8
    if (late) upgradeTexture(t, '/' + urls[tier])
    t.colorSpace = key.endsWith('_base') ? THREE.SRGBColorSpace : THREE.NoColorSpace
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.userData.sharedWorld = true; surfaces[key] = t; tick()
  }))
  await Promise.all(lightMaps.map(async key => {
    const t = await imageLoader.loadAsync('/' + manifest[key]); t.colorSpace = THREE.NoColorSpace
    // RGBM is encoded data: mipmap averaging its RGB and multiplier separately
    // changes the lighting. Use the same full-resolution maps on every device.
    t.generateMipmaps = false; t.minFilter = t.magFilter = THREE.LinearFilter
    t.flipY = false; t.userData.sharedWorld = true; maps[key] = t; tick()
  }))
  const data = async (path, anisotropy) => {
    const t = await loader.loadAsync('/' + path); t.colorSpace = THREE.NoColorSpace; t.anisotropy = anisotropy
    t.userData.sharedWorld = true; tick(); return t
  }
  const ground = await data(manifest.ground, 4), headReach = await data(manifest.head_reach, 4)
  const stone = manifest.head_stone ? await loadHeadStone(manifest.head_stone, tier === 'low') : null
  if (stone) tick()
  const [x, y, z] = manifest.field.dims
  const part = async name => {
    const lobes = await Promise.all(manifest.field.files[name].map(async path => {
      const bytes = await download('/' + path, { label: 'Lighting asset' })
      if (bytes.byteLength !== x * y * z * 8) throw new Error('Invalid lighting field size')
      return Float32Array.from(new Uint16Array(bytes), THREE.DataUtils.fromHalfFloat)
    }))
    tick(); return lobes
  }
  const lamp = await part('lamp'), sky = await part('sky'), moon = await part('moon')
  const volume = (...parts) => parts[0].map((_, i) => {
    const sum = new Uint16Array(x * y * z * 4)
    for (let k = 0; k < sum.length; k++) sum[k] = THREE.DataUtils.toHalfFloat(k % 4 === 3 ? 1 : parts.reduce((total, lobes) => total + lobes[i][k], 0))
    const t = new THREE.Data3DTexture(sum, x, y, z)
    t.type = THREE.HalfFloatType; t.colorSpace = THREE.NoColorSpace; t.minFilter = t.magFilter = THREE.LinearFilter; t.needsUpdate = true; t.userData.sharedWorld = true
    return t
  })
  return { manifest, surfaces, maps, ground, headReach, stone, fields: { ground: volume(lamp, sky), canopy: volume(lamp, sky, moon), lamps: volume(lamp), lamp }, tier }
}

// The colours and strengths used below and in every material are in world.palette (public/data/palette.json).
// The lamps' balance, their fade toward violet and their soft clip are applied when the light is packed
// (palette.json "bake"); lamps.gain and lamps.fade here are a second, live adjustment for trying things out.

export const luma = colour => dot(colour, vec3(.2126, .7152, .0722))

// The baked lamp light as the palette wants it: an overall gain, and weak light leaning toward another hue
// (lamps.fade: the tint applies fully below `below`, not at all above `above`), so a pink pool fades through
// violet into the blue around it rather than into red or brown on warm surfaces.
// lamps.far (the 60:30:10 rule's accent goes to the statue): lamp light farther than far.range[0] metres from the
// statue shifts its hue toward far.tint (fully beyond far.range[1]) at the same brightness, so pink pools on the banks
// read as the secondary violet and the pink accent stays on the Moai.
const farActive = (world, far) => far && world.statue && far.tint.some(c => c !== 1)
export function lampGrade(world, light, p = positionWorld) {
  const { gain, fade, far } = world.palette.lamps
  let out = gain === 1 ? light : light.mul(gain)
  if (fade.tint.some(c => c !== 1)) out = out.mul(mix(vec3(...fade.tint), vec3(1), smoothstep(fade.below, fade.above, luma(out))))
  if (farActive(world, far)) {
    const shifted = out.mul(vec3(...far.tint)), same = shifted.mul(luma(out).div(luma(shifted).max(1e-6)))
    const away = smoothstep(far.range[0], far.range[1], length(p.xz.sub(vec2(world.statue.base.x, world.statue.base.z))))
    out = mix(out, same, away)
  }
  return out
}
// The same for one colour on the processor (leaf cards store their lamp light at load); changes `rgb` in place.
export function lampGradeValues(world) {
  const { gain, fade, far } = world.palette.lamps, tinted = fade.tint.some(c => c !== 1), farOn = farActive(world, far)
  const step = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / Math.max(b - a, 1e-6))); return t * t * (3 - 2 * t) }
  const lumOf = (r, g, b) => .2126 * r + .7152 * g + .0722 * b
  return (rgb, at = 0, x = 0, z = 0) => {
    for (let c = 0; c < 3; c++) rgb[at + c] *= gain
    if (tinted) {
      const keep = step(fade.below, fade.above, lumOf(rgb[at], rgb[at + 1], rgb[at + 2]))
      for (let c = 0; c < 3; c++) rgb[at + c] *= fade.tint[c] + (1 - fade.tint[c]) * keep
    }
    if (farOn) {
      const away = step(far.range[0], far.range[1], Math.hypot(x - world.statue.base.x, z - world.statue.base.z))
      if (away === 0) return
      const lum = lumOf(rgb[at], rgb[at + 1], rgb[at + 2])
      // (plain numbers, no arrays: called six times for every leaf card built)
      const s0 = rgb[at] * far.tint[0], s1 = rgb[at + 1] * far.tint[1], s2 = rgb[at + 2] * far.tint[2], k = lum / Math.max(lumOf(s0, s1, s2), 1e-6)
      rgb[at] += (s0 * k - rgb[at]) * away; rgb[at + 1] += (s1 * k - rgb[at + 1]) * away; rgb[at + 2] += (s2 * k - rgb[at + 2]) * away
    }
  }
}

// The light grid's six lobes at a point: light arriving from +x, -x, +y, -y, +z, -z (six lookups).
export function gridLobes(world, p = positionWorld, set = 'ground') {
  const { fields, manifest } = world.cinematic, box = manifest.field
  const dims = vec3(...box.dims)
  const coord = p.sub(vec3(...box.min)).div(vec3(...box.max.map((v,i)=>v-box.min[i]))).clamp()
    .mul(dims.sub(1).div(dims)).add(vec3(.5).div(dims))
  return fields[set].map(field => texture3D(field,coord).rgb)
}

// The light grid at a point, as a function of the surface normal, so one set of lookups can light several normals.
export function fieldLobes(world, p = positionWorld, set = 'ground') {
  if (!world.cinematic) return () => vec3(0)
  const lobes = gridLobes(world, p, set)
  return n => {
    const weights = [n.x.max(0),n.x.negate().max(0),n.y.max(0),n.y.negate().max(0),n.z.max(0),n.z.negate().max(0)]
    let light = vec3(0)
    for (let i=0;i<6;i++) light = light.add(lobes[i].mul(weights[i].pow(2)))
    return light.min(vec3(12))
  }
}

export function fieldLight(world, p = positionWorld, n = normalWorld, set = 'ground') {
  return fieldLobes(world, p, set)(n)
}

// A light map (see loadCinematic), decoded.
export function bakedLight(world, key, coords = uv()) {
  const map = texture(world.cinematic.maps[key],coords)
  return map.rgb.mul(map.a).mul(world.cinematic.manifest.rgbmRange)
}

// The terrain-wide maps at a world position: .r ground contact occlusion, .g the moon's reach, .b the sky's.
export function groundMaps(world, p = positionWorld) {
  return texture(world.cinematic.ground, p.xz.mul(uniform(world.uvScale)).add(uniform(world.uvOffset)))
}

// Compress very bright baked light (the pools right under the pink lamps) and let it lose saturation as it
// brightens: lit surfaces keep their own colour and texture instead of turning flat magenta.
export function softLight(light, knee = 3, minSaturation = .6) {
  const lum = luma(light), gain = lum.div(knee).add(1).reciprocal()
  return mix(vec3(lum.mul(gain)), light.mul(gain), mix(1, minSaturation, smoothstep(knee * .15, knee * 1.5, lum)))
}
