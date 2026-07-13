import { useEffect, useState } from 'react'
import { Matrix4 } from 'three/webgpu'
import { dot, float, mix, mx_noise_float, positionWorld, smoothstep, texture, uv, vec3 } from 'three/tsl'
import { bakedLight, lampGrade } from './cinematic.js'
import { bakedColour, bakedMaterial, moonHighlight } from './bakedMaterial.js'
import { groundContact, heightAboveGround } from './grounding.js'
import { stoneSurface } from './stoneTile.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { disposeObject } from './resources.js'
import { download } from './bytes.js'

// The statue is the one thing in the scene with live light: its own three lamps (pink key, pink rim, blue fill)
// and the moon are worked out per pixel from its normal map and roughness, so its relief and highlights answer
// the camera. Each of the four is multiplied by the baked share of that light reaching the point (headReach:
// key, rim, fill, moon), which replaces a shadow map. Everything else that lights it is baked (the 'head' light
// map: the other lamps, the sky, and what the four live lights bounce off the ground).
// The lamps' positions, colours and strengths are fitted to the Cycles bake (pack_cinematic.py), so the direct
// light here equals the render's. What the statue wears (the flower tiara and the studs, ForestAssets.jsx) takes the
// same lamps, unshadowed (reach 1).
export function liveLight(world, normal, roughness, reach) {
  const share = { L_Moai_Magenta_Key: reach.r, L_Moai_Rim_Back: reach.g, L_Moai_Blue_Fill_R: reach.b }
  const keep = world.palette.statue.saturation
  let diffuse = vec3(0), shine = vec3(0)
  for (const lamp of world.cinematic.manifest.statue.lights) {
    const toLamp = vec3(...lamp.position).sub(positionWorld), d2 = dot(toLamp, toLamp), l = toLamp.mul(d2.inverseSqrt())
    let shape = d2.reciprocal()
    const along = lamp.direction ? dot(l.negate(), vec3(...lamp.direction)) : null
    if (lamp.cosHalf !== undefined) shape = shape.mul(smoothstep(0, 1, along.sub(lamp.cosHalf).div(lamp.blend)))   // a spot's cone
    if (lamp.area) shape = shape.mul(along.max(0))                                                                  // a flat emitter
    // statue.saturation: the stone keeps the lamps' brightness but only part of their hue.
    const grey = .2126 * lamp.color[0] + .7152 * lamp.color[1] + .0722 * lamp.color[2]
    const arriving = vec3(...lamp.color.map(c => (grey + (c - grey) * keep) * lamp.strength)).mul(shape).mul(share[lamp.name])
    diffuse = diffuse.add(arriving.mul(dot(normal, l).max(0)))
    shine = shine.add(arriving.mul(moonHighlight(normal, l, roughness)))
  }
  return { diffuse, shine }
}

// The foot of the stone, where it goes into the ground (palette statue.foot): damp soil clinging to it up to a
// ragged line `height` metres above the ground (± `ragged`), patched with moss, and above that a band `wick`
// metres tall that the damp has darkened (to `wickDark`). Measured from the terrain's height map, so it follows the
// ground all round; the line wanders with a noise that is wider along the ground than up the stone. Returns the
// albedo and how much of the point is soil (0 to 1): soil is matte, it takes no highlight.
function buried(world, albedo) {
  const F = world.palette.statue.foot
  if (!F) return { albedo, soil: float(0) }
  const h = heightAboveGround(world)
  const fine = mx_noise_float(positionWorld.mul(19))
  const line = mx_noise_float(positionWorld.mul(vec3(4, 1.6, 4))).mul(F.ragged).add(F.height).add(fine.mul(.02))
  const soil = smoothstep(line.sub(F.fade), line.add(.015), h).oneMinus().toVar()
  const wick = smoothstep(line, line.add(F.wick), h).oneMinus()
  const mossy = smoothstep(.1, .45, mx_noise_float(positionWorld.mul(7))).mul(F.mossShare)
  const ground = mix(vec3(...F.soil), vec3(...F.moss), mossy).mul(fine.mul(.3).add(1))
  return { albedo: mix(albedo.mul(mix(1, F.wickDark, wick.mul(wick))), ground, soil), soil }
}

// The statue: its stone is two small unique maps (colour, coarse relief) plus a repeating relief tile (stoneTile.js);
// its light is the baked head light map plus its own live lamps and the moon.
export function Moai({ world, url, transform, onError, onProgress }) {
  const [scene, setScene] = useState(null)
  useEffect(() => {
    let cancelled = false, model
    download(url, { label: 'Statue', onProgress: share => { if (!cancelled) onProgress?.(.85 * share) } })
      .then(bytes => new GLTFLoader().parseAsync(bytes, url.slice(0, url.lastIndexOf('/') + 1))).then((gltf) => {
      model = gltf.scene
      if (cancelled) { disposeObject(model); return }
      model.name = 'SculptedMoai'
      if (transform) model.applyMatrix4(new Matrix4().fromArray(transform))
      model.traverse((object) => {
        if (!object.isMesh) return
        object.renderOrder = -3 // drawn first: whatever it hides is then skipped
        const old = object.material, stone = world.cinematic.stone
        if (!stone) throw new Error('Statue stone textures are missing from lighting.json (head_stone)')
        const material = bakedMaterial(); material.name = old.name
        const reach = texture(world.cinematic.headReach, uv())
        const { albedo: colour, occlusion, normal, roughness: stoneRoughness } = stoneSurface(stone)
        // Crevice occlusion and the darkening toward the ground it stands in (grounding.js) go into the albedo,
        // so they shade every light.
        const { albedo, soil } = buried(world, colour.mul(mix(1, occlusion, .85)).mul(groundContact(world, .55, .4)))
        const roughness = mix(stoneRoughness, 1, soil)
        material.userData.maps = { base: stone.macro, normal: stone.tile }     // for the scene checks
        const lamps = liveLight(world, normal, roughness, reach)
        material.colorNode = bakedColour(world, {
          albedo, light: lampGrade(world, bakedLight(world, 'head')).add(lamps.diffuse), reach: reach.a, normal, roughness, emission: lamps.shine,
        })
        object.material = material
        for (const value of Object.values(old)) if (value?.isTexture) value.dispose()
        old.dispose()
      })
      setScene(model)
      onProgress?.(1)
    }).catch((error) => { if (!cancelled) onError?.(`Head: ${error.message}`) })
    return () => { cancelled = true; if (model) disposeObject(model) }
  }, [world, url, transform, onError, onProgress])
  return scene ? <primitive object={scene} dispose={null} /> : null
}
