import * as THREE from 'three/webgpu'
import { dot, equirectUV, smoothstep, texture, vec3 } from 'three/tsl'
import { defaultTier } from '../quality.js'
import { download, fetchOk } from './bytes.js'
import { decodeStars } from './stars.js'

// ?skyLegacy (development): the sky as it was until 2026-11-17, for comparison: stars baked into a 4k panorama (2k on
// phones), FXAA over the open sky and the lamps' glow lifting the whole sky. ?skyLegacy=stars,fxaa,glow brings back
// only the parts named.
function legacyParts() {
  if (!import.meta.env?.DEV || typeof location === 'undefined') return new Set()
  const value = new URLSearchParams(location.search).get('skyLegacy')
  return new Set(value === null ? [] : value ? value.split(',') : ['stars', 'fxaa', 'glow'])
}
export const SKY_LEGACY = legacyParts()

// Night sky graded from a Poly Haven HDRI (blender/scripts/pack_sky.py), in the scene's own horizon-to-zenith palette,
// stored as 8-bit sRGB plus a scale (and, for the old panorama, a highlight gain). Three parts: the haze (the
// panorama without its point stars, 2k on every device), the stars (stars.js) and the sky light (the whole sky,
// stars included, at the 4k panorama's mip 3) for everything that looks the sky up blurred.
export async function loadSky(entry) {
  if (!entry) return null
  const file = SKY_LEGACY.has('stars') && entry.file === 'sky/sky.json' ? 'sky/sky_legacy.json' : entry.file
  const info = await (await fetchOk('/' + file, { label: 'Sky' })).json()
  const files = info.files ? info.files[defaultTier() === 'high' ? 'high' : 'low'] : info.file
  if (!info.stars) {
    // A panorama with the stars in it: its own mips are the sky light.
    const map = await picture(files, true)
    const haze = { map, scale: info.scale, gain: info.gain, highlight: info.highlight, level: 0 }
    return { ...info, haze, light: haze, stars: null, fogLevel: Math.max(0, Math.log2(map.image.width / 32)) }
  }
  const [map, light, bytes] = await Promise.all([picture(files, false), picture(info.light.file, true), download('/' + info.stars.file, { label: 'Stars' })])
  return { ...info, haze: { map, scale: info.scale, gain: info.gain, level: 0 }, light: { ...info.light, map: light, gain: 0 },
    stars: { ...info.stars, ...decodeStars(new Uint8Array(bytes), info.stars.count) }, fogLevel: 7 }
}

async function picture(file, mipmaps) {
  const map = await new THREE.TextureLoader().loadAsync('/' + file)
  map.colorSpace = THREE.SRGBColorSpace; map.wrapS = THREE.RepeatWrapping; map.wrapT = THREE.ClampToEdgeWrapping
  map.generateMipmaps = mipmaps; map.minFilter = mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter; map.userData.sharedWorld = true
  return map
}

// Scene-linear sky radiance along a direction. `level` is a mip of the 4k panorama: 0, the full detail of the haze
// (stars.js draws the stars over it); any other the sky light, blurred that much (fog: sky.fogLevel, about 11 degrees).
export function skyRadiance(sky, direction, level = 0) {
  const part = level === 0 ? sky.haze : sky.light
  const sample = texture(part.map, equirectUV(direction)).level(Math.max(0, level - part.level))
  if (!part.gain) return sample.rgb.mul(part.scale)
  const highlight = smoothstep(part.highlight[0], part.highlight[1], dot(sample.rgb, vec3(.2126, .7152, .0722)))
  return sample.rgb.mul(part.scale).mul(highlight.mul(part.gain).add(1))
}
