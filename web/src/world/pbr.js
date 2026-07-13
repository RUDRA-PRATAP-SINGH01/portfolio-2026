import * as THREE from 'three/webgpu'
import { Fn, If, cameraViewMatrix, frontFacing, mix, normalLocal, normalWorld, normalize, positionWorld, smoothstep, texture, transformNormalToView, uniform, uv, varying, vec2, vec3, vec4, attribute } from 'three/tsl'
import { bakedLight, ktx2Loader, fieldLight, fieldLobes, groundMaps, lampGrade, softLight } from './cinematic.js'
import { bakedColour, bakedMaterial, mappedNormal } from './bakedMaterial.js'
import { groundContact } from './grounding.js'
import { reflectionPass } from './animation.js'
import { fetchOk } from './bytes.js'
import { reliefScale } from './relief.js'
import { wetSheen } from './wetSheen.js'
import { PBR_LEGACY } from './pbrLegacy.js'
import { TEXTURES_LOW } from '../quality.js'
import { LATE, upgradeTexture } from './lateTextures.js'

// Maps no material reads are not loaded: the twig cards take their light at their corners, without their normal map
// (trees/TreeSystem.js; its development switch ?treeLegacy=twigLight reads it again).
const twigLight = import.meta.env?.DEV && typeof location !== 'undefined' && /(^|,)(twigLight|all)(,|$)/.test(new URLSearchParams(location.search).get('treeLegacy') ?? '')
const unread = (set, key) => set === 'twig' && key === 'normal' && !twigLight && !PBR_LEGACY.has('unused')

// Tiling PBR sets (blender/scripts/pbr_texture_sets.py) and baked unique-UV atlases (pack_pbr_macro.py).
// Every set is base (sRGB), normal (OpenGL) and arh = ambient occlusion, roughness, height.
// The 512 tier is ~2 mm per texel on a metre-sized bark tile, finer than any on-screen texel.
export async function loadPbr(entry, progress = () => {}) {
  if (!entry) return null
  const manifest = await (await fetchOk('/' + entry.file, { label: 'PBR textures' })).json(), tier = entry.tier ?? 'low'
  const loader = await ktx2Loader()
  const maps = (s, set) => Object.entries(s).filter(([key, files]) => files && typeof files === 'object' && !Array.isArray(files) && files[tier] && !unread(set, key))
  const total = Object.entries(manifest.sets).reduce((n, [name, s]) => n + maps(s, name).length, 0) + Object.keys(manifest.macro ?? {}).length
  let done = 0
  const load = async (path, color, wrap = THREE.RepeatWrapping) => {
    const t = await loader.loadAsync('/' + path)
    t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace
    t.wrapS = t.wrapT = wrap; t.anisotropy = 8; t.userData.sharedWorld = true
    progress(++done / total)
    return t
  }
  // Every map a set lists (most have base, normal, arh; moss has data, normal); only 'base' is colour.
  const sets = Object.fromEntries(await Promise.all(Object.entries(manifest.sets).map(async ([name, s]) =>
    [name, Object.fromEntries(await Promise.all(maps(s, name).map(async ([key, files]) => [key, await load(files[tier], key === 'base')])))])))
  // Atlases cover 0..1 once; clamping keeps mip filtering from wrapping across the border. The rocks are basic hulls
  // whose shape is in their atlas (mf_lowpoly_rocks.py): desktops take it at 1024 (phones at the tier's 512), after the
  // reveal (lateTextures.js).
  const macro = Object.fromEntries(await Promise.all(Object.entries(manifest.macro ?? {}).map(async ([name, files]) => {
    const desktop = !TEXTURES_LOW && name.startsWith('rock_macro') && files.high, late = desktop && LATE && files[tier] !== files.high
    const t = await load(files[desktop && !late ? 'high' : tier], false, THREE.ClampToEdgeWrapping)
    return [name, late ? upgradeTexture(t, '/' + files.high) : t]
  })))
  return { sets, macro }
}

// One material for bark, twig cards and rocks. Geometry provides uv (the tiling set) and, for baked
// surfaces, uv1: the same islands packed without rotation, so both normal maps share one tangent frame.
//   grounded: things that stand on the terrain (trunks, rocks) darken toward it (grounding.js).
//   light:    where the baked light comes from (bakedMaterial.js):
//               'rocks', 'wood_hero', 'wood_bg'  the light map of that atlas (uv1); the moon's reach is the green
//                                                channel of the occlusion atlas (macroAO)
//               'ground'                         the light grid, and the moon's reach from the terrain's map
//                                                (rocks placed more than once share their atlas)
//               'canopy'                         the light grid with the moon in it (twigs up in the crowns)
//   vertexLight: read the light grid at the vertices, not per pixel. Its cells are metres wide, so on small
//               surfaces (twig cards) the light is the same and six 3D lookups per pixel are saved; where nothing
//               else reads the per-pixel normal, the normal map is then not read at all.
//   cheapReflection: in the pond's reflection (blurred and rippled) the surface is lit by its geometric normal,
//               without normal map or highlight. A real branch on a uniform: only one side runs.
//   wet:        within palette.pbr.wet.band metres above the water, where the ground is wet (rocks by the pond), the
//               surface mirrors the sky as the wet ground does (wetSheen.js).
//   ownTangents: the geometry brings its tangents from the export (MikkTSpace, glTF's convention: the normal map's
//               green axis is not flipped); without them three works the frame out from the texture coordinates.
export function pbrMaterial(world, { name, set, macroAO, macroNormal, alpha = false, moss = 0, glowKey, light = 'ground', normalStrength = 1, grounded = false, vertexLight = false, cheapReflection = false, wet = false, ownTangents = false }) {
  const maps = world.pbr.sets[set], P = world.palette
  const m = bakedMaterial({ side: THREE.DoubleSide, alphaTest: alpha ? .45 : 0 })
  m.name = name
  const base = texture(maps.base, uv()), arh = texture(maps.arh, uv()), macro = macroAO ? texture(macroAO, uv(1)) : null
  let occlusion = arh.r
  if (macro) occlusion = occlusion.mul(macro.r)
  if (grounded) occlusion = occlusion.mul(groundContact(world, .45, .5))
  let color = base.rgb
  if (moss) {
    // Moss settles on up-facing surfaces, first in the low parts of the height map.
    const cover = smoothstep(.35, .85, normalWorld.y).mul(smoothstep(.8, .3, arh.b)).mul(moss)
    color = mix(color, vec3(...P.surfaces.moss), cover)
  }
  const mapped = ['rocks', 'wood_hero', 'wood_bg'].includes(light)
  const reach = mapped ? macro.g : light === 'ground' ? groundMaps(world).g : null
  // The per-pixel normal is read by the light grid (unless that is read at the vertices) and by the direct moonlight.
  let normal = normalWorld
  if (reach !== null || !vertexLight) {
    let detail = texture(maps.normal, uv()).xyz.mul(2).sub(1)
    if (macroNormal) {
      const shape = texture(macroNormal, uv(1)).xyz.mul(2).sub(1)
      detail = normalize(vec3(detail.xy.add(shape.xy), detail.z.mul(shape.z)))   // whiteout blend
    }
    // glTF texture coordinates run top-down, so the tangent-space green axis flips (as GLTFLoader does).
    normal = mappedNormal(detail.mul(.5).add(.5), vec2(normalStrength, ownTangents ? normalStrength : -normalStrength))
  }
  // Rocks and trunks sit in the pink pools by the statue. A light map has that light soft-clipped when it is
  // packed; the grid's is soft-clipped here, so the surface texture survives.
  const grade = l => softLight(lampGrade(world, l), P.lamps.knee.surface, P.lamps.minSaturation)
  let incoming, relief = null
  if (mapped) {
    incoming = lampGrade(world, bakedLight(world, light, uv(1)))
    relief = normal !== normalWorld && reliefScale(world, normal)
  }
  else if (vertexLight) {
    // At the vertices, for both faces (the cards are two-sided and a face is lit from its own side, as the
    // per-pixel normal of a two-sided surface is): one set of six lookups, two normals; the pixel picks its face.
    const n = transformNormalToView(normalLocal).transformNormalByInverseViewMatrix(cameraViewMatrix).normalize()
    const lobes = fieldLobes(world, positionWorld, light)
    incoming = frontFacing.select(varying(grade(lobes(n))), varying(grade(lobes(n.negate()))))
  } else incoming = grade(fieldLight(world, positionWorld, normal, light))
  const albedo = color.mul(mix(1, occlusion, .9)), roughness = arh.g
  let emission = glowKey ? vec3(...P.glow.branch).mul(attribute(glowKey, 'float')).mul(P.glow.branchStrength) : null
  const W = wet && world.palette.pbr?.wet, share = W && wetness(world, W.band)
  const sheen = W && wetSheen(world, { wet: share, normal, skyReach: varying(groundMaps(world).b) })
  // Only the sheen. Darkened as the wet ground is (Terrain.jsx), stones by the water lost their detail; at the wet
  // ground's roughness of .24 the moon's highlight broke their carved shape into white blotches.
  if (sheen) emission = emission ? emission.add(sheen) : sheen
  let lit
  if (cheapReflection) {
    lit = Fn(() => {
      // What both sides read is fetched before the branch; the normal map and the highlight only on the full side.
      const a = albedo.toVar(), lightIn = incoming.toVar(), r = reach?.toVar() ?? null, out = vec3(0).toVar()
      If(reflectionPass.greaterThan(.5), () => { out.assign(bakedColour(world, { albedo: a, light: lightIn, reach: r, emission })) })
        .Else(() => { out.assign(bakedColour(world, { albedo: a, light: relief ? lightIn.mul(relief) : lightIn, reach: r, normal, roughness, emission })) })
      return out
    })()
  } else lit = bakedColour(world, { albedo, light: relief ? incoming.mul(relief) : incoming, reach, normal, roughness, emission })
  m.colorNode = alpha ? vec4(lit, base.a) : lit
  return m
}

// How wet a surface is at its vertices: the ground's wetness under it (terrain data, alpha), fading out `band` metres
// above the water and nothing below it (there the pond's surface mirrors the sky).
function wetness(world, band) {
  const water = world.meta.water_level, p = positionWorld
  const ground = texture(world.dataTexture, p.xz.mul(uniform(world.uvScale)).add(uniform(world.uvOffset))).a
  return varying(ground.mul(smoothstep(water + band, water, p.y)).mul(smoothstep(water - .005, water + .03, p.y)))
}
