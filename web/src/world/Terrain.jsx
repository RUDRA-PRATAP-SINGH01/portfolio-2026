import * as THREE from 'three/webgpu'
import { useEffect, useMemo, useState } from 'react'
import { Fn, If, attribute, cameraPosition, cross, dot, mix, mx_noise_float, normalize, normalWorld, positionWorld, select, smoothstep, texture, uniform, varying, vec2, vec3, vec4 } from 'three/tsl'
import { lin } from './data.js'
import { KEEP_OUT } from './keepOut.js'
import { bakedLight, groundMaps, lampGrade } from './cinematic.js'
import { bakedColour, bakedMaterial, mappedNormal } from './bakedMaterial.js'
import { reliefScale } from './relief.js'
import { wetSheen } from './wetSheen.js'
import { PBR_LEGACY } from './pbrLegacy.js'

// Development switches: ?groundLegacy draws the full grid (127k triangles) with the noises worked out per vertex,
// for comparisons; ?groundDebug shows the two noises (red soil patches, green tint drift) instead of the ground;
// ?guard marks the keep-out ground (keepOut.js) for scripts/check-path-guard.mjs (see guardMarker).
const params = import.meta.env.DEV && typeof location !== 'undefined' ? new URLSearchParams(location.search) : null
const LEGACY = !!params?.has('groundLegacy'), DEBUG = !!params?.has('groundDebug'), GUARD = !!params?.has('guard')

// The guard's marker: pure green, with the distance to the eye (/100 m) in blue, so the check can weigh each pixel
// by what the fog would leave of it (keepOut.js fogVisible). Drawn without fog, and shown raw (Post.jsx).
const guardMarker = () => vec3(0, 1, positionWorld.distance(cameraPosition).div(100))

// Ground built on the CPU from the Blender height map (exact same heights the grass reads on the GPU).
// One static mesh: nothing is rebuilt or re-sent while the camera moves. Every vertex of the grid is kept, with the
// full grid's normals; the triangle list is lighter where the ground is flat (groundMesh.js).
// Its light is baked (bakedMaterial.js): the terrain light map, plus direct moonlight by the soil's normal map
// where the baked moon reach says the moon arrives.
// One build per world: a change of quality tier makes a new scene and reuses it.
const grounds = new WeakMap()

export function Terrain({ world }) {
  const [built, setBuilt] = useState(() => grounds.get(world) ?? null)
  useEffect(() => {
    if (grounds.has(world)) return void setBuilt(grounds.get(world))
    const worker = new Worker(new URL('./ground.worker.js', import.meta.url), { type: 'module' })
    worker.onmessage = ({ data }) => { worker.terminate(); if (!data.error) grounds.set(world, data); setBuilt(data) }
    worker.onerror = event => { worker.terminate(); setBuilt({ error: event.message || 'The ground could not be built' }) }
    worker.postMessage({ heights: world.heights, R: world.resolution, bounds: world.bounds, shoreBox: world.shore?.box ?? null, water: world.meta.water_level, legacy: LEGACY })
    return () => worker.terminate()
  }, [world])
  if (built?.error) throw new Error(built.error)                      // the scene's error boundary shows it
  const parts = useMemo(() => {
    if (!built) return null
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(built.positions, 3))
    g.setAttribute('normal', new THREE.BufferAttribute(built.normals, 3))
    g.setAttribute('uv', new THREE.BufferAttribute(built.uvs, 2))
    g.setIndex(new THREE.BufferAttribute(built.index, 1))
    g.computeBoundingBox(); g.computeBoundingSphere()
    const noise = built.noise && noiseTexture(built.noise, 256)
    const shore = world.shore && shoreGround(world, g, 255, LEGACY)
    const moss = shore && world.palette.terrain.mossTile > 0 && world.pbr?.sets.moss     // mossTile 0: no moss layer
    return { geometry: g, shore, noise, material: groundMaterial(world, { noise }), shoreMaterial: shore && groundMaterial(world, { moss, shore: true }), void: GUARD ? guardVoid(world) : null }
  }, [world, built])
  useEffect(() => parts ? () => { parts.geometry.dispose(); parts.shore?.dispose(); parts.material.dispose(); parts.shoreMaterial?.dispose(); parts.noise?.dispose(); parts.void?.geometry.dispose(); parts.void?.material.dispose() } : undefined, [parts])
  if (!parts) return null
  const { geometry, shore, material, shoreMaterial } = parts

  // Drawn after the grass, plants and trees that cover much of it (the sky dome alone comes later).
  return <>
    <mesh name="Terrain" geometry={geometry} material={material} renderOrder={40} />
    {shore && <mesh name="TerrainShore" geometry={shore} material={shoreMaterial} renderOrder={40} />}
    {parts.void && <mesh name="GuardVoid" geometry={parts.void.geometry} material={parts.void.material} renderOrder={40} />}
  </>
}

// The two noises at the grid's vertices (groundMesh.js), half floats, one texel per vertex.
function noiseTexture(data, n) {
  const half = new Uint16Array(data.length)
  for (let k = 0; k < data.length; k++) half[k] = THREE.DataUtils.toHalfFloat(data[k])
  const t = new THREE.DataTexture(half, n, n, THREE.RGFormat, THREE.HalfFloatType)
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearFilter; t.needsUpdate = true
  return t
}

// The forest floor; with `moss` (the island shore only, so the rest of the ground costs nothing more) a moss
// carpet is laid where the shore mesh's per-vertex `moss` cover says it grows (blender/scripts/mf_shore_build.py).
// With `noise` (the grid) the two noises are read from that texture; without it (the shore patch, whose vertices
// are not on the grid) they are worked out per vertex.
// `shore`: the shore patch's mesh has no texture coordinates, from which three takes a normal map's directions, so
// there they are given by the world axes the maps are laid along (axisNormal).
function groundMaterial(world, { moss = null, noise = null, shore = false } = {}) {
  const uvS = uniform(world.uvScale), uvO = uniform(world.uvOffset), P = world.palette.terrain
  const d = texture(world.dataTexture, positionWorld.xz.mul(uvS).add(uvO))
  // The noises are much coarser than the ground mesh (0.27 m cells): their values at the grid's vertices, blended
  // between them (texel centres on the vertices: N texels span N - 1 cells).
  const N = noise?.image.width
  const both = noise && texture(noise, positionWorld.xz.mul(uvS).add(uvO).mul((N - 1) / N).add(.5 / N))
  const n = noise ? both.r : varying(mx_noise_float(positionWorld.xz.mul(0.6))).mul(0.5).add(0.5)
  const m = bakedMaterial()
  const t = world.cinematic.surfaces, coords = positionWorld.xz.mul(.42)
  const soilWeight = smoothstep(.28, .7, n).mul(d.r.mul(.55).oneMinus())
  const soilColor = texture(t.soil_base, coords.mul(.87).add(vec2(.13, .27))).rgb.mul(vec3(...P.soil))
  const litter = texture(world.groundTextures.base, coords).rgb.mul(vec3(...P.litter))
  const mossColor = mix(litter, vec3(...P.moss), d.r.mul(.32))
  const ground = mix(mossColor, soilColor, soilWeight).mul(mix(1, .5, d.a))
  // Slow drift of hue across the forest floor: cooler, mossier hollows and warmer, drier rises.
  const region = noise ? both.g : varying(mx_noise_float(positionWorld.xz.mul(.085))).mul(.5).add(.5)
  let tinted = ground.mul(mix(vec3(...P.cool), vec3(...P.warm), smoothstep(.25, .75, region)))
  // The soil's roughness map (mean .46) lies under the clamp but for a few texels: its mean draws the same.
  const soilRoughness = PBR_LEGACY.has('unused') ? texture(t.soil_roughness, coords.mul(.87)).r : .46
  let roughness = mix(texture(t.ground_roughness, coords).r, soilRoughness, soilWeight).clamp(.55, .98)
  let normalSample = mix(texture(world.groundTextures.normal, coords).rgb, texture(t.soil_normal, coords.mul(.87)).rgb, soilWeight)
  if (moss) {
    // Carpet moss (moss_texture_set.py: two CC0 scans, grey; the colour is the palette's). One lookup per map, turned
    // off the world axes; a second, small lookup adds the fine grain of the tufts (soft at arm's length) and breaks the
    // repeat. Measured on the Intel chip: two lookups per map and a per-pixel noise cost 0.4-0.55 ms more.
    const muv = vec2(positionWorld.x.mul(.8).sub(positionWorld.z.mul(.6)), positionWorld.x.mul(.6).add(positionWorld.z.mul(.8))).div(P.mossTile)
    // data: R tone (linear mean 0.2), G occlusion, B roughness, A height of the tufts
    const data = texture(moss.data, muv), fine = P.mossGrain === 0 ? data : texture(moss.data, muv.mul(3.7).add(vec2(.43, .71)))
    const tufts = data.a
    // Where it grows: the mesh's cover, broken by a slow noise and the fine tufts; at the carpet's edge the tufts
    // (height) show first, so it ends in ragged clumps with soil between them, not in a blur.
    const ragged = varying(mx_noise_float(positionWorld.xz.mul(1.9))).mul(.3).add(fine.a.sub(.5).mul(.18))
    const cover = smoothstep(.44, .58, attribute('moss', 'float').add(ragged).add(tufts.sub(.5).mul(.32)))
    // Soft light and shade (strong occlusion between the cushions reads as cracked mud), lighter on the tufts.
    // Deep blue-teal in the hollows, lighter teal on top: 'greens only as dark quiet teal' (the M3 colour rules).
    const shade = mix(1, data.r.mul(5), .7).mul(mix(1, data.g, .5)).mul(mix(1, fine.r.mul(5), .3))
    const tone = mix(vec3(...P.mossDeep), vec3(...P.mossTip), smoothstep(.15, .95, tufts))
    // Velvet: moss scatters light at grazing angles, which is what reads as soft, most of all where it rolls over a lip.
    const grazing = dot(normalWorld, normalize(cameraPosition.sub(positionWorld))).clamp(0, 1).oneMinus().pow(2.5)
    const carpet = tone.mul(shade).mul(grazing.mul(P.mossSheen).add(1)).mul(mix(1, .62, d.a))
    tinted = mix(tinted, carpet, cover)
    roughness = mix(roughness, data.b, cover)
    // Gentle relief: the cushions' normals at half strength (full strength drew sharp-edged cells).
    if (P.mossRelief !== 0) normalSample = mix(normalSample, mix(vec3(.5, .5, 1), texture(moss.normal, muv).rgb, .5), cover)
  }
  // Baked over the whole terrain: contact occlusion where trunks, roots, rocks and the statue sit into the
  // ground (bake_ground_contact.py), and the share of the moon that reaches each point (bake_cinematic.py).
  const maps = groundMaps(world)
  let albedo = mix(tinted, vec3(lin(P.silt)), smoothstep(.02, .15, d.b)).mul(mix(1, maps.r, P.contact))
  // Around the statue's foot (palette statue.foot.skirt): the soil the stone was sunk into, dark and damp where the
  // stone shades the ground (the baked contact map, below `contact`), in ragged patches, within `near` metres of it.
  // The statue stands on the island's shore patch, so only that material has it, and only pixels within `near` metres
  // do the work (a real branch: they lie together on screen).
  const S = moss && world.palette.statue.foot?.skirt
  if (S && world.statue) {
    const base = vec2(world.statue.base.x, world.statue.base.z), contact = maps.r
    const found = Fn(() => {                                              // soil colour (rgb) and its share (a)
      const out = vec4(0).toVar(), away = positionWorld.xz.sub(base).length().toVar(), shade = contact.toVar()
      If(away.lessThan(S.near), () => {
        const near = smoothstep(S.near, S.near * .6, away)
        const shaded = smoothstep(S.contact[0], S.contact[1], shade.add(mx_noise_float(positionWorld.xz.mul(5.5)).mul(S.ragged)))
        out.assign(vec4(vec3(...S.soil).mul(mx_noise_float(positionWorld.xz.mul(23)).mul(.3).add(1)), near.mul(shaded).mul(S.strength)))
      })
      return out
    })()
    albedo = mix(albedo, found.rgb, found.a)
    roughness = mix(roughness, .95, found.a)
  }
  roughness = mix(roughness, .24, d.a)
  const normal = !shore ? mappedNormal(normalSample, vec2(.7)) : PBR_LEGACY.has('shore') ? normalWorld : axisNormal(normalSample, .7)
  let light = lampGrade(world, bakedLight(world, 'terrain', positionWorld.xz.mul(uvS).add(uvO)))
  const relief = normal !== normalWorld && reliefScale(world, normal)
  if (relief) light = light.mul(relief)
  // Wet (d.a) above the water only: the pond's own surface mirrors the sky over the ground under it.
  const wet = d.a.mul(smoothstep(world.meta.water_level - .005, world.meta.water_level + .03, positionWorld.y))
  const sheen = wetSheen(world, { wet, normal, skyReach: maps.b })
  m.colorNode = DEBUG ? vec3(smoothstep(.28, .7, n), smoothstep(.25, .75, region), 0) : bakedColour(world, { albedo, light, reach: maps.g, normal, roughness, emission: sheen })
  if (GUARD) {
    // Dry and outside the dressed box (keepOut.js; Blender y = -z). The rest of the ground draws as before, unfogged.
    const { x0, x1, y0, y1 } = KEEP_OUT.dressed, x = positionWorld.x, y = positionWorld.z.negate()
    const dressed = x.greaterThanEqual(x0).and(x.lessThanEqual(x1)).and(y.greaterThanEqual(y0)).and(y.lessThanEqual(y1))
    m.colorNode = select(dressed.not().and(positionWorld.y.greaterThan(world.meta.water_level)), guardMarker(), m.colorNode)
    m.fog = false
  }
  return m
}

// A ground normal map's normal on a mesh without texture coordinates: the maps are laid along the world's x and z
// (Terrain's coords), so their tangent is world x and their bitangent -z, as the grid's texture coordinates give
// three (groundMesh.js: u along x, v against z), so the shore patch and the grid around it shade alike.
function axisNormal(sample, strength) {
  const N = normalWorld, T = normalize(vec3(1, 0, 1e-3).sub(N.mul(N.x.add(N.z.mul(1e-3))))), B = cross(N, T)
  const s = sample.mul(2).sub(1)
  return normalize(T.mul(s.x.mul(strength)).add(B.mul(s.y.mul(strength))).add(N.mul(s.z)))
}

// ?guard: the void beyond the terrain's edges, marked: a flat frame around the terrain a little below its lowest
// ground, so it shows wherever a view looks past an edge.
function guardVoid(world) {
  const { x0, x1, y0, y1 } = world.bounds, far = 1000
  const frame = new THREE.Shape([new THREE.Vector2(-far, -far), new THREE.Vector2(far, -far), new THREE.Vector2(far, far), new THREE.Vector2(-far, far)])
  frame.holes.push(new THREE.Path([new THREE.Vector2(x0, y0), new THREE.Vector2(x0, y1), new THREE.Vector2(x1, y1), new THREE.Vector2(x1, y0)]))
  const geometry = new THREE.ShapeGeometry(frame).rotateX(-Math.PI / 2).translate(0, world.meta.terrain.height_min - .25, 0)  // (x, y) -> (x, 0, -y)
  const material = new THREE.MeshBasicNodeMaterial({ fog: false, side: THREE.DoubleSide })
  material.colorNode = guardMarker()
  return { geometry, material }
}

// The statue island's shoreline (blender/scripts/mf_shore.py) needs ~4 cm detail; the grid's cells are 27 cm.
// Inside its box the grid's cells are dropped (by lighterGrid; here for the full grid of ?groundLegacy) and a light
// Blender mesh (rows along the shore) takes their place. Its edge vertices lie on the grid's edges and take the grid's
// own (linear) heights there, and the grid's cells along the box stay whole, so no crack opens.
function shoreGround(world, grid, seg, cutGrid) {
  const { x0, x1, y0, y1 } = world.bounds, [bx0, bx1, by0, by1] = world.shore.box, e = 1e-4
  const p = grid.attributes.position
  if (cutGrid) {
    const src = grid.index.array, kept = []
    for (let k = 0; k < src.length; k += 6) {           // PlaneGeometry: two triangles (6 indices) per cell
      let cx = 0, cz = 0
      for (let m = 0; m < 6; m++) { cx += p.getX(src[k + m]); cz += p.getZ(src[k + m]) }
      cx /= 6; cz /= 6
      if (cx > bx0 && cx < bx1 && -cz > by0 && -cz < by1) continue
      for (let m = 0; m < 6; m++) kept.push(src[k + m])
    }
    grid.setIndex(kept)
  }
  const dx = (x1 - x0) / seg, dy = (y1 - y0) / seg, h = world.heightAt
  const lerpEdge = (along, fixed, start, step, horizontal) => {
    const j = Math.min(seg - 1, Math.floor((along - start) / step + e)), t = (along - start) / step - j
    const a = start + j * step, b = a + step
    const ha = horizontal ? h(a, -fixed) : h(fixed, -a), hb = horizontal ? h(b, -fixed) : h(fixed, -b)
    return ha + (hb - ha) * t
  }
  const pos = world.shore.positions.slice()
  for (let v = 0; v < pos.length; v += 3) {
    const x = pos[v], y = -pos[v + 2]
    if (Math.abs(x - bx0) < e || Math.abs(x - bx1) < e) pos[v + 1] = lerpEdge(y, x, y0, dy, false)
    else if (Math.abs(y - by0) < e || Math.abs(y - by1) < e) pos[v + 1] = lerpEdge(x, y, x0, dx, true)
  }
  // Normals come with the mesh: the designed surface's own, so a few thousand triangles shade like a dense mesh
  // (computed from these triangles, the bank faces would be smeared into the flat ground beside them).
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.BufferAttribute(world.shore.normals, 3))
  g.setAttribute('moss', new THREE.BufferAttribute(world.shore.moss, 1))
  g.setIndex(new THREE.BufferAttribute(world.shore.index, 1))
  g.computeBoundingBox(); g.computeBoundingSphere()
  return g
}
