import * as THREE from 'three/webgpu'
import { useEffect, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { attribute, cameraPosition, clamp, dot, float, fract, mix, mx_noise_float, normalWorld, normalize,
  length, positionLocal, positionWorld, pow, reflect, sin, smoothstep, texture, uniform, uv, varying, vec2, vec3, vec4 } from 'three/tsl'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { disposeObject } from './resources.js'
import { download } from './bytes.js'
import { fieldLight, lampGrade, luma, softLight } from './cinematic.js'
import { bakedColour, bakedMaterial, mappedNormal } from './bakedMaterial.js'
import { pbrMaterial } from './pbr.js'
import { floatingKind, prepareFloating, animateFloating } from './floating.js'
import { motionTime } from './animation.js'
import { groundContact } from './grounding.js'
import { skyRadiance } from './sky.js'
import { levelParts, plantLevels } from './plantLevels.js'
import { liveLight } from './Moai.jsx'

// Everything here is lit from the bake (bakedMaterial.js): the light grid for lamps and sky, and direct moonlight
// where the terrain's moon-reach map says the moon arrives at the plant's spot (looked up per vertex).
const gridLight = (world, normal, set = 'ground') =>
  softLight(lampGrade(world, fieldLight(world, positionWorld, normal, set)), world.palette.lamps.knee.surface, world.palette.lamps.minSaturation)
const groundReach = world => varying(texture(world.cinematic.ground, positionWorld.xz.mul(uniform(world.uvScale)).add(uniform(world.uvOffset))).level(1).g)

// Lily pad (blender/scripts/mf_lilypads.py + lilypad_textures.py): a waxy leaf with veins, wet and dry patches
// and beads of water. The sky glances off it by its roughness; each leaf carries its own tint (instance colour).
function lilyPadMaterial(original, world) {
  const maps = world.pbr.sets.lilypad, S = world.palette.surfaces
  const m = bakedMaterial({ side: THREE.DoubleSide, alphaTest: .5 })
  m.name = original.name
  const base = texture(maps.base, uv()), arh = texture(maps.arh, uv())
  let albedo = base.rgb.mul(mix(1, arh.r, .8))
  if (S.padTint.some(c => c !== 1)) albedo = albedo.mul(vec3(...S.padTint))
  const normal = mappedNormal(texture(maps.normal, uv()), vec2(1, -1))
  let sheen = null
  if (world.sky) {
    const view = normalize(cameraPosition.sub(positionWorld)), gloss = arh.g.oneMinus()
    const fresnel = pow(float(1).sub(clamp(dot(normal, view), 0, 1)), 5).mul(.96).add(.04)
    const mirrored = reflect(view.negate(), normal)
    // A sheen, not a mirror: only the wet, glossy parts pick the sky up, so the leaf keeps its green.
    sheen = skyRadiance(world.sky, normalize(vec3(mirrored.x, mirrored.y.abs(), mirrored.z)), 4).mul(fresnel).mul(pow(gloss, 3)).mul(S.padSheen)
  }
  // base.a: bites, insect holes, the tear
  m.colorNode = vec4(bakedColour(world, { albedo, light: gridLight(world, normal), reach: groundReach(world), normal, roughness: arh.g, emission: sheen }), base.a)
  return m
}

// Soft dark meniscus where a pad meets the water (the ring just outside its rim; uv.x = 0 at the leaf).
function padContactMaterial(original, world) {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false })
  m.name = original.name
  const near = uv().x.oneMinus()
  m.colorNode = vec3(...world.palette.surfaces.padContact); m.opacityNode = near.mul(near).mul(.55)
  return m
}

// single: the object is placed once, so its own atlas islands hold its light (rocks).
function materialFor(original, geometry, world, source = '', single = false) {
  // Low-poly rocks (blender/scripts/mf_lowpoly_rocks.py): tiling rock set + baked shape normal and occlusion.
  if (/Rock_PBR/.test(original.name) && world.pbr) return pbrMaterial(world, {
    name: original.name, set: 'rock', moss: .8, grounded: true, light: single ? 'rocks' : 'ground', wet: true,
    macroAO: world.pbr.macro.rock_macro_ao, macroNormal: world.pbr.macro.rock_macro_normal,
    ownTangents: geometry.hasAttribute('tangent'),
  })
  if (/LilyPad_Contact/.test(original.name)) return padContactMaterial(original, world)
  if (/LilyPad/.test(original.name) && world.pbr?.sets.lilypad) return lilyPadMaterial(original, world)
  const G = world.palette.glow, S = world.palette.surfaces
  const leafy = /fern|moss_01|periwinkle|grass_medium/i.test(original.name)
  const material = bakedMaterial({ side: THREE.DoubleSide, alphaTest: leafy ? .4 : original.alphaTest })
  material.name = original.name
  for (const map of [original.map, original.emissiveMap]) if (map) map.anisotropy = 4
  const texel = original.map ? texture(original.map, uv()) : null, tone = original.color
  let albedo = texel ? texel.rgb.mul(vec3(tone.r, tone.g, tone.b)) : vec3(tone.r, tone.g, tone.b)
  // Emission is kept in a range the bloom halo can carry without burning out to white-pink:
  // the crown bulbs stay the brightest points, the periwinkle blossoms glow softly. The statue's pink studs
  // (blender/scripts/studs.py) glow past the bloom threshold at glow.stud.
  const strength = /Garland_Bulb/.test(original.name) ? G.bulb : /M_Stud/.test(original.name) ? G.stud ?? G.bulb
    : /periwinkle/.test(original.name) ? original.emissiveIntensity * G.periwinkle : original.emissiveIntensity
  const glowing = original.emissive.r + original.emissive.g + original.emissive.b > 0 && strength > 0
  const glowColour = vec3(original.emissive.r * strength, original.emissive.g * strength, original.emissive.b * strength)
  let emission = !glowing ? null : original.emissiveMap ? texture(original.emissiveMap, uv()).rgb.mul(glowColour) : glowColour
  if (/Hydrocharis/.test(original.name)) {
    // Small floating leaves: dark night green rather than black.
    const patch = varying(mx_noise_float(positionWorld.xz.mul(2.3))).mul(.5).add(.5)
    albedo = vec3(tone.r, tone.g, tone.b).mul(S.hydrocharis).mul(patch.mul(.25).add(.88))
  }
  if (/Flower_(Pink_Glow|Centre)/.test(original.name) && geometry.hasAttribute('_flower')) {
    // Every flower carries a random id (blender/scripts/mf_flower_ids.py). The sprays are thinned with it,
    // more so right beside the statue, and each surviving flower gets its own brightness: most glow softly,
    // a few sparkle.
    // The share kept is decided once per plant (flowerKeep, an instanced attribute): a threshold that varied
    // across a flower would drop some of its vertices and stretch the rest.
    const id = attribute('_flower', 'float'), keep = id.lessThan(attribute('flowerKeep', 'float'))
    material.positionNode = keep.select(positionLocal, vec3(0))    // dropped flowers collapse to a point
    const bright = fract(id.mul(53.19).add(.37))                   // independent of the thinning order
    const glow = mix(.45, 1.35, bright).add(pow(bright, 9).mul(3.2))
    const breathe = sin(motionTime.mul(bright.mul(.8).add(.3)).add(id.mul(47))).mul(.14).add(1)
    let hue = mix(vec3(...G.flower), vec3(...G.flowerAlt), fract(id.mul(17.3)).mul(G.flowerAltShare)), power = glow.mul(breathe)
    // Away from the statue the flowers lean toward the second hue and dim (glow.farHue, glow.farDim): the
    // strongest pink stays where the eye should go. flowerFar is 0 beside the statue, 1 out on the banks.
    if (G.farHue !== 0 || G.farDim !== 1) {
      const far = attribute('flowerFar', 'float')
      hue = mix(hue, vec3(...G.flowerAlt), far.mul(G.farHue)); power = power.mul(mix(1, G.farDim, far))
    }
    // glow.nearGain: the flowers around the statue (flowerFar 0, within glow.farRange[0] metres) glow this much
    // brighter, easing back to normal by glow.farRange[1]; the brightest of them reach the bloom.
    if ((G.nearGain ?? 1) !== 1) power = power.mul(mix(G.nearGain, 1, attribute('flowerFar', 'float')))
    emission = hue.mul(power).mul(/Centre/.test(original.name) ? G.flowerCentre : 1)
  }
  if (/Nymphaea_Petal/.test(original.name) && geometry.hasAttribute('_petal')) {
    const petal = attribute('_petal', 'float').clamp()
    albedo = mix(vec3(...S.petalLight), vec3(...S.petalDeep), petal)
    // Water lilies glow from within; loose petals adrift on the water only catch a little of it.
    emission = /Floating_Petal/.test(source) ? vec3(...G.lilyAdrift).mul(petal.mul(.5).add(.9)) : vec3(...G.lily).mul(petal.mul(2).add(2.3))
    // glow.lilyFar: like the flowers, lilies away from the statue lean toward the second hue and dim.
    const LF = G.lilyFar
    if (LF && world.statue && (LF.hue !== 0 || LF.dim !== 1)) {
      const away = smoothstep(LF.range[0], LF.range[1], length(positionWorld.xz.sub(vec2(world.statue.base.x, world.statue.base.z))))
      emission = mix(emission, vec3(...G.flowerAlt).mul(luma(emission)).div(luma(vec3(...G.flowerAlt))), away.mul(LF.hue)).mul(mix(1, LF.dim, away))
    }
  }
  // Plants and props darken toward the ground they grow from; things afloat or on the statue do not.
  const aloft = /Nymphaea|Hydrocharis|Floating_Petal|Garland|Tiara|Stud/.test(source + original.name)
  if (!aloft) albedo = albedo.mul(groundContact(world, .35, .5))
  // The garland, the flower tiara and the studs are on the statue's head, far above the ground the reach map
  // describes: they take the moon from the light grid instead.
  const crown = /Garland|Tiara|Stud/.test(source + original.name)
  let light = gridLight(world, normalWorld, crown ? 'canopy' : 'ground')
  // What the statue wears (the flower tiara, the studs) also takes its three live lamps, as the stone around it does
  // (Moai.jsx liveLight), unshadowed: with the canopy grid alone the roses came out darker than the stone under them.
  if (/Tiara|Stud/.test(source + original.name) && world.cinematic?.manifest?.statue) light = light.add(liveLight(world, normalWorld, float(.6), vec4(1)).diffuse)
  const lit = bakedColour(world, { albedo, light, reach: crown ? null : groundReach(world), emission })
  material.colorNode = texel ? vec4(lit, texel.a) : lit
  return material
}

const scatter = (x, z) => { const v = Math.sin(x * 127.1 + z * 311.7) * 43758.5453; return v - Math.floor(v) }

// Per-instance tint. Lily pads age from fresh blue-green to tired yellow, with the odd reddish leaf;
// other plants drift a little between cooler and warmer greens. Everything else keeps a plain shade.
function instanceTint(color, source, variation, x, z, surfaces) {
  const shade = .82 + variation * .3, h = scatter(x, z)
  if (/LilyPad/.test(source)) {
    const red = Math.max(0, h - .9) * 3, light = .8 + .4 * scatter(z, x)
    return color.setRGB(light * (.9 + .2 * variation + surfaces.padRed * red), light * (1.04 - .06 * variation - .2 * red), light * (1.04 - .26 * variation))
  }
  if (/fern|moss|periwinkle|Geranium|Spray|Aspidistra|Rush|Primula|grass/i.test(source)) {
    const warm = (h - .5) * surfaces.plantWarm
    return color.setRGB(shade * (1 + warm), shade * (1 + warm * .2), shade * (1 - warm))
  }
  return color.setScalar(shade)
}

export function ForestAssets({ world, onError, onProgress }) {
  const [group, setGroup] = useState(null)
  useEffect(() => {
    let cancelled = false, result
    const manifest = world.sceneManifest
    if (!manifest) { onProgress?.(1); return }
    const url = '/' + manifest.models
    download(url, { label: 'Scene asset', onProgress: share => { if (!cancelled) onProgress?.(.75 * share) } })
      .then(bytes => new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes, url.slice(0, url.lastIndexOf('/') + 1))).then((gltf) => {
      if (cancelled) { disposeObject(gltf.scene); return }
      onProgress?.(.82)
      result = new THREE.Group(); result.name = 'ForestDetails'
      const materials = new Map(), batches = new Map(), matrix = new THREE.Matrix4(), color = new THREE.Color()
      const levels = plantLevels(world)
      // The share of a spray's flowers shown beside the statue and out on the banks. The export leaves out the
      // flowers that neither can show (scene.json flower_keep_limit), so neither may ask for more than that.
      const G = world.palette.glow, flowerLimit = manifest.flower_keep_limit ?? 1
      const nearKeep = Math.min(G.nearKeep ?? .26, flowerLimit), farKeep = Math.min(G.farKeep ?? .42, flowerLimit)
      if (import.meta.env.DEV && Math.max(G.nearKeep ?? .26, G.farKeep ?? .42) > flowerLimit) console.warn(`palette glow.nearKeep / farKeep ask for more flowers than were exported (${flowerLimit}): run export_browser_scene.py again`)
      let instances = 0, triangles = 0
      gltf.scene.updateMatrixWorld(true)
      world.floatObstacles=[]
      for(const entry of manifest.prototypes) if(/^(RK_|ST_|ROOT_|LOG_)|Boulder|rock|Root|Log|fallen/i.test(entry.source)) {
        const proto=gltf.scene.getObjectByName(entry.name)
        if(!proto)continue
        const box=new THREE.Box3().setFromObject(proto)
        for(const instance of entry.instances) {
          const b=box.clone().applyMatrix4(matrix.fromArray(instance.matrix)),center=b.getCenter(new THREE.Vector3()),size=b.getSize(new THREE.Vector3())
          if (b.max.y<world.meta.water_level-.025 || b.min.y>world.meta.water_level+.15) continue
          world.floatObstacles.push({x:center.x,z:center.z,radius:Math.hypot(size.x,size.z)*.5})
        }
      }
      const decoded = new Set()
      gltf.scene.traverse(object => {
        const geometry = object.geometry
        if (!geometry || decoded.has(geometry)) return
        decoded.add(geometry)
        // WebGPU has no scalar u16 vertex format (e.g. the quantized petal mask).
        // Decode integer attributes once; retain Meshopt's small transfer size.
        for (const [name, attribute] of Object.entries(geometry.attributes)) {
          const array = attribute.isInterleavedBufferAttribute ? attribute.data.array : attribute.array
          if (array instanceof Float32Array) continue
          const data = new Float32Array(attribute.count * attribute.itemSize)
          const getters = ['getX', 'getY', 'getZ', 'getW']
          for(let i=0;i<attribute.count;i++) for(let c=0;c<attribute.itemSize;c++) data[i*attribute.itemSize+c] = attribute[getters[c]](i)
          geometry.setAttribute(name, new THREE.Float32BufferAttribute(data, attribute.itemSize))
        }
        geometry.computeBoundingBox(); geometry.computeBoundingSphere()
      })
      const floatingPlacements=prepareFloating(world,manifest.prototypes,gltf.scene)
      for (const entry of manifest.prototypes) {
        const prototype = gltf.scene.getObjectByName(entry.name)
        if (!prototype) throw new Error(`Missing prototype ${entry.name}`)
        prototype.traverse((source) => {
          if (!source.isMesh) return
          const floating=floatingKind(world,entry.source)
          const single = entry.instances.length === 1 && !floating
          // Three's instancing turns a copy's normal but not its tangent: the rocks placed more than once, which bring
          // their tangents (export_browser_scene.py), are drawn as static geometry in world space, as rocks placed once.
          const flat = single || !floating && source.geometry.hasAttribute('tangent')
          const key = source.material.uuid + source.geometry.hasAttribute('_petal') + source.geometry.hasAttribute('_flower') + source.geometry.hasAttribute('tangent') + single + (floating ? entry.name+source.name : '')
          if (!materials.has(key)) materials.set(key, materialFor(source.material, source.geometry, world, entry.source, single))
          if (flat) for (const instance of entry.instances) {
            const geometry = source.geometry.clone()
            // The flower tiara and the studs bring their own colours (blender/scripts/flower_tiara.py, studs.py:
            // COLOR_0; on the studs it also shades the glow, lighter on the table than at the rim); every other copy drawn
            // this way gets one plain shade.
            const own = /^Moai_(Tiara|Stud)/.test(entry.source) ? geometry.getAttribute('color') : null
            for (const name of Object.keys(geometry.attributes)) if (!['position', 'normal', 'tangent', 'uv', 'uv1', '_petal'].includes(name)) geometry.deleteAttribute(name)
            // (Every attribute is float already, widened above, so the world transform cannot overflow.)
            geometry.applyMatrix4(matrix.fromArray(instance.matrix).multiply(source.matrixWorld))
            if (!geometry.attributes.uv) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(geometry.attributes.position.count*2), 2))
            const colors = new Float32Array(geometry.attributes.position.count * 3).fill(.82 + instance.variation * .3)
            if (own) for (let i = 0; i < own.count; i++) { colors[i * 3] = own.getX(i); colors[i * 3 + 1] = own.getY(i); colors[i * 3 + 2] = own.getZ(i) }
            geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
            if (!batches.has(key)) batches.set(key, { material: materials.get(key), geometries: [] })
            batches.get(key).geometries.push(geometry)
            instances++
            triangles += (geometry.index?.count ?? geometry.attributes.position.count) / 3
          }
          if (flat) return
          const mesh = new THREE.InstancedMesh(source.geometry, materials.get(key), entry.instances.length)
          mesh.name = entry.source + '_' + source.name
          entry.instances.forEach((instance, index) => {
            matrix.fromArray(instance.matrix).multiply(source.matrixWorld)
            mesh.setMatrixAt(index, matrix)
            mesh.setColorAt(index, instanceTint(color, entry.source, instance.variation, instance.matrix[12], instance.matrix[14], world.palette.surfaces))
          })
          mesh.matrixAutoUpdate = false
          if (/LilyPad_Contact/.test(source.material.name)) mesh.renderOrder = 1   // blends over the water
          // this part's lighter levels (null where a level lacks its material, the part itself for stems: plantLevels.js)
          const lighter = floating ? [] : levelParts(entry.lod, name => gltf.scene.getObjectByName(name), source)
          if (source.geometry.hasAttribute('_flower')) {
            // Share of this plant's flowers that stay beside the statue (glow.nearKeep) easing to glow.farKeep out on the banks.
            const keep = Float32Array.from(entry.instances, ({ matrix: m }) => {
              const d = world.statue ? Math.hypot(m[12] - world.statue.base.x, m[14] - world.statue.base.z) : 99
              return THREE.MathUtils.lerp(nearKeep, farKeep, THREE.MathUtils.smoothstep(d, 3, 7.5))
            })
            const [from, to] = world.palette.glow.farRange
            const far = Float32Array.from(entry.instances, ({ matrix: m }) =>
              world.statue ? THREE.MathUtils.smoothstep(Math.hypot(m[12] - world.statue.base.x, m[14] - world.statue.base.z), from, to) : 1)
            // a level's flower cards are thinned and tinted copy by copy as the full mesh's flowers are
            for (const geometry of new Set([source.geometry, ...lighter.filter(Boolean).map(level => level.geometry)])) {
              geometry.setAttribute('flowerKeep', new THREE.InstancedBufferAttribute(keep.slice(), 1))
              geometry.setAttribute('flowerFar', new THREE.InstancedBufferAttribute(far.slice(), 1))
            }
          }
          mesh.computeBoundingBox(); mesh.computeBoundingSphere()
          if(floating) animateFloating(mesh,world,floating,floatingPlacements.get(entry.name))
          // Flat floating leaves and petals lie on the water plane: their true mirror image is hidden beneath
          // them, so they stay out of the pond's reflection (upright water lilies are kept).
          mesh.userData.noReflection=/fern|moss|grass|Stem|Floating_Petal|Hydrocharis|LilyPad/i.test(entry.source)
          result.add(mesh)
          // Copies out of sight are not sent (plantLevels.js), except those afloat: their drift is kept per copy in its
          // own buffer (floating.js). The lighter levels are drawn with the prototype's own material.
          const whole = lighter.length > 0 && lighter.every(level => level === source)   // stems: plantLevels.js KEEP_WHOLE
          if (!floating) for (const level of levels.add(mesh, whole ? { ...entry, lod: [] } : entry, whole ? [] : lighter)) result.add(level)
          instances += mesh.count
          triangles += (source.geometry.index?.count ?? source.geometry.attributes.position.count) / 3 * mesh.count
        })
      }
      for (const batch of batches.values()) {
        const geometry = mergeGeometries(batch.geometries)
        if (!geometry) throw new Error('Could not merge static forest geometry')
        const material = batch.material.clone(); material.vertexColors = true
        const mesh = new THREE.Mesh(geometry, material)
        mesh.name = 'Static_' + material.name; mesh.matrixAutoUpdate = false
        result.add(mesh); batch.geometries.forEach(g => g.dispose())
      }
      const retained = new Set(result.children.map(object => object.geometry))
      gltf.scene.traverse(object => { if (object.geometry && !retained.has(object.geometry)) object.geometry.dispose() })
      const originals = new Set()
      gltf.scene.traverse((object) => { if (object.isMesh) originals.add(object.material) })
      originals.forEach((material) => material.dispose())
      result.userData.levels = levels
      result.userData.stats = { prototypes: manifest.prototypes.length, placements: manifest.prototypes.reduce((n,p)=>n+p.instances.length,0), instances, triangles, draws: result.children.length }
      if (cancelled) { disposeObject(result); return }
      setGroup(result)
      onProgress?.(1)
    }).catch((error) => { if (!cancelled) { console.error('Forest assets failed', error); onError?.(`Forest: ${error.message}`) } })
    return () => { cancelled = true; if (result) disposeObject(result) }
  }, [world, onError, onProgress])
  useFrame(({ camera, size, viewport }) => { group?.userData.levels.update(camera, size.height * viewport.dpr) })
  return group ? <primitive object={group} dispose={null} /> : null
}
