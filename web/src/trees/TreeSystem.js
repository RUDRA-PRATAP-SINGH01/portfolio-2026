import * as THREE from 'three/webgpu'
import { attribute, uniform, texture, uv, vec2, vec3, vec4, positionGeometry, normalGeometry, frontFacing, sin, sqrt, float, mix, dot, cross, length, smoothstep, varyingProperty, cameraPosition, cameraProjectionMatrix, modelViewMatrix, normalize, dFdx, dFdy, Fn, If, max } from 'three/tsl'
import { motionTime as time, reflectionPass } from '../world/animation.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { decodeRecords, groupCells, LOD_BAND, nearestFirst } from './lod.js'
import { ktx2Loader, lampGradeValues } from '../world/cinematic.js'
import { holdLate } from '../world/lateTextures.js'
import { download, fetchOk } from '../world/bytes.js'
import { disposeObject } from '../world/resources.js'
import { pbrMaterial } from '../world/pbr.js'
import { adaptive } from '../world/AdaptiveQuality.jsx'
import { ORBIT } from '../world/CameraRig.jsx'
import { swingReach } from '../world/parallax.js'
import { scroll } from '../world/scroll.js'
import { warmup } from '../loading/warmup.js'

// Development switches for comparisons: ?treeLegacy=a,b,... (or all) draws that part the earlier, slower way.
//   tangents    the bark's tangent frame rebuilt per pixel from screen derivatives (no tangent attribute)
//   twigLight   twig cards read the light grid per pixel, through their normal map
//   reflection  bark fully shaded in the pond's reflection
//   leafDetail  the leaves' detail map read with explicit gradients (textureSampleGrad)
//   leafGlow    the canopy glow worked out on every leaf pixel, glowing or not
const LEGACY = new Set(import.meta.env?.DEV && typeof location !== 'undefined' ? (new URLSearchParams(location.search).get('treeLegacy') ?? '').split(',').filter(Boolean) : [])
const legacy = (key) => LEGACY.has(key) || LEGACY.has('all')
// ?cullLegacy (development): every leaf card lit, on screen or not, as before. =leaves for this part alone (=plants:
// the plants' part, world/plantLevels.js).
const cull = import.meta.env?.DEV && typeof location !== 'undefined' ? new URLSearchParams(location.search).get('cullLegacy') : null
const LIGHT_ALL = cull != null && (cull === '' || cull.split(',').includes('leaves'))
// ?woodWhole (development): every wood chunk drawn, in view or not, as when each family was one mesh.
const WOOD_WHOLE = import.meta.env?.DEV && typeof location !== 'undefined' && new URLSearchParams(location.search).has('woodWhole')

export async function loadTrees(entry, tier, signal, onProgress = () => {}) {
  if (!entry) return null
  if (entry.version !== 1) throw new Error('Unsupported tree export version')
  const manifest = await (await fetchOk('/' + entry.file, { signal, label: 'Tree asset' })).json()
  if (manifest.version !== 3 || manifest.levels.length !== 3 || !manifest.maps || !manifest.grid) throw new Error('Invalid tree manifest')
  onProgress(.04)
  // color: leaf colour with the cut-out in alpha.  detail: relief, glow mask, thickness, occlusion.
  // (blender/scripts/foliage_leaf_maps.py; block-compressed, mipmaps stored in the files.)
  const textures = {}, loader = await ktx2Loader()
  try {
    for (const key of ['color', 'detail']) {
      // Keep detailed cutouts on High; smaller mipmapped atlases reduce mobile texture memory.
      const t = textures[key] = await loader.loadAsync('/' + manifest.maps[tier.label === 'High' ? 'high' : 'low'][key])
      t.colorSpace = key === 'color' ? THREE.SRGBColorSpace : THREE.NoColorSpace
      t.anisotropy = 4
      onProgress(.04 + .24 * Object.keys(textures).length / 2)
    }
    // The near leaves (level 0, 3.2 MB of the 3.9 MB of leaves) are not waited for: TreeSystem fetches them in a
    // worker once the scene is showing (loadNear); until then the mid sprays stand in for them close up as well.
    let decoded = 0
    const levels = await Promise.all(manifest.levels.map(async (level, index) => {
      if (index === 0) return null
      // (Some hosts send the gzip file with Content-Encoding, and fetch has then unpacked it; others as it is.)
      const bytes = await download('/' + level.file, { signal, label: 'Tree asset' })
      const records = decodeRecords(bytes, level.count, manifest.grid)
      onProgress(.28 + .40 * ++decoded / (manifest.levels.length - 1))
      return records
    }))
    const gltfLoader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)
    const woodBytes = await download('/' + manifest.wood, { signal, label: 'Tree asset' })
    onProgress(.84)
    const wood = await gltfLoader.parseAsync(woodBytes, '/foliage/')
    if (signal.aborted) { disposeObject(wood.scene); throw new DOMException('Cancelled', 'AbortError') }
    onProgress(.94)
    return { manifest, textures, levels, wood: wood.scene }
  } catch (error) { Object.values(textures).forEach((t) => t.dispose()); throw error }
}

// One card: a near leaf (level 0), folded along its midrib, or two crossed planes showing a spray of leaves
// (levels 1 and 2). Two triangles per flat piece: the atlas's alpha, relief and occlusion carry the leaf shape.
// A card is cut to the box around the leaves in its atlas tile (tile.trim, from foliage_atlas.py): the tiles
// are up to half empty around them, and that border would be rasterised for nothing.
function geometry(manifest, species, level) {
  const tile = manifest.tiles.find((t) => t.species === species && t.spray === (level !== 0))
  const [x0, y0, x1, y1] = tile.bounds, [u0, v0, u1, v1] = tile.trim.box, lerp = THREE.MathUtils.lerp
  // The outline in tile fractions, as (lower, upper) pairs from left to right: joined in order they form a strip.
  const outline = (level === 0 ? [u0, .5, u1] : [u0, u1]).flatMap((s) => [[s, v0], [s, v1]])
  // A leaf is cupped: each half rises from the midrib to where the cup stands at the tile's edge.
  const cup = (x, y) => species === 0 ? .018 * (x / .085) ** 2 + .003 * (y / .085) ** 2 : .004 * (x / .048) ** 2
  const folded = (s, t) => {
    const [from, to, across] = s < .5 ? [x0, (x0 + x1) / 2, s * 2] : [(x0 + x1) / 2, x1, s * 2 - 1]
    return lerp(lerp(cup(from, y0), cup(from, y1), t), lerp(cup(to, y0), cup(to, y1), t), across)
  }
  const pos = [], tex = [], indices = []
  // Sprays are large alpha-tested cards: a third plane costs more in overdraw than it adds in volume.
  const planes = level === 0 ? 1 : 2
  for (let plane = 0; plane < planes; plane++) {
    const offset = pos.length / 3, angle = plane * Math.PI / planes
    for (const [s, t] of outline) {
      const x = x0 + (x1 - x0) * s, y = y0 + (y1 - y0) * t
      // A spray plane stays where the uncut card was: flat, at the height its edges had.
      const z = level > 0 ? .018 * (x1 / .2) ** 2 : folded(s, t)
      pos.push(x * Math.cos(angle) + z * Math.sin(angle), y, z * Math.cos(angle) - x * Math.sin(angle))
      tex.push(species * .5 + s * .5, (level === 0 ? 0 : .5) + t * .5)
    }
    for (let i = offset; i + 3 < offset + outline.length; i += 2) indices.push(i, i + 2, i + 3, i, i + 3, i + 1)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(tex, 2)); g.setIndex(indices); g.computeVertexNormals()
  if (level > 0) {
    // A softly rounded cluster normal, following Bruno's volume-normal approach.
    const normals = g.attributes.normal, positions = g.attributes.position
    const normal = new THREE.Vector3(), radial = new THREE.Vector3()
    for (let i = 0; i < normals.count; i++) {
      normal.fromBufferAttribute(normals, i)
      radial.fromBufferAttribute(positions, i).addScaledVector(normal, .16).normalize()
      normal.lerp(radial, .55).normalize(); normals.setXYZ(i, normal.x, normal.y, normal.z)
    }
  }
  g.computeBoundingSphere()
  return g
}

// The canopy is divided into blocks of BLOCK metres, and a block changes level as a whole: by the distance from
// the camera to the sphere around it (BLOCK_RADIUS). Near leaves are lit one by one and come out darker than
// the sprays that stand for them, so where the change happens is part of the look: keep the blocks as they are.
const BLOCK = 3, BLOCK_RADIUS = 2.6
// Leaves are drawn in cubic cells of this many blocks a side, one draw per cell and species, for near leaves,
// mid sprays and far sprays. Near leaves are by far the most numerous and show only within a few metres: a
// cell of them is one block, drawn only while that block is near, and prepared when the camera first comes
// close: AHEAD metres before it is needed, nearest first, for BUILD_MS of a frame (a fixed count of cards took
// 2 ms on a laptop's fast cores and up to 40 ms on its slow ones; the fullest block holds 14,000). A quick scroll
// (or "Back to start") covers AHEAD in a frame or two: whenever the page is scrolled to a new place, the near cells
// on the camera's way there are queued (queueWay, EYES_PER_ORBIT eyes a whole orbit). While the camera rests, the
// rest are prepared, IDLE_MS a frame, so a scroll later finds them ready (all of them, ~10 MB, exist after one orbit
// anyway).
const CELL_BLOCKS = [1, 4, 8], AHEAD = 1.5, BUILD_MS = 2, IDLE_MS = 1, EYES_PER_ORBIT = 60

// The cells of a level (lod.js groupCells, here or in the near-leaf worker) with their box and block centres as
// three.js objects. box: where the cards stand; reach: their largest scale; blocks: the centres of their blocks.
function asCells({ cells, order }) {
  return { order, cells: cells.map((c) => ({ species: c.species, count: c.count, start: c.start, reach: c.reach,
    box: new THREE.Box3(new THREE.Vector3(c.box[0], c.box[1], c.box[2]), new THREE.Vector3(c.box[3], c.box[4], c.box[5])),
    blocks: Array.from({ length: c.blocks.length / 3 }, (_, k) => new THREE.Vector3().fromArray(c.blocks, k * 3)), mesh: null })) }
}
const cellsOf = (records, blocks) => asCells(groupCells(records, BLOCK, blocks))

// Near leaves give way to mid sprays around tier.foliageNear metres between the camera and a block's sphere,
// and mid sprays to far ones around tier.foliageFar, each cluster at its own point of these bands.
const lodRange = (tier) => ({ near: LOD_BAND.map((edge) => edge * tier.foliageNear), far: LOD_BAND.map((edge) => edge * tier.foliageFar) })

// The baked lamp light (the light field of cinematic.js) is looked up once per card, here on the processor,
// and stored with the card: the light arriving from +x, -x, +y, -y, +z, -z as six colours of one byte per
// channel (square roots, to keep dim light) and one multiplier for all six, in the fourth byte of the first.
const FIELD_LIMIT = 12       // brightest stored light, as in fieldLobes()
function fieldEncoder(world) {
  if (!world.cinematic) return null
  // The lamps alone: leaves work their sky and moon light out themselves (material(), below).
  const { fields, manifest } = world.cinematic, { dims: [nx, ny, nz], min, max } = manifest.field
  const volumes = fields.lamp, lobe = new Float32Array(18)
  const along = (v, axis, n) => Math.min(1, Math.max(0, (v - min[axis]) / (max[axis] - min[axis]))) * (n - 1)
  const grade = lampGradeValues(world)
  return (x, y, z, out, at) => {
    const fx = along(x, 0, nx), fy = along(y, 1, ny), fz = along(z, 2, nz)
    const x0 = Math.min(Math.floor(fx), nx - 2), y0 = Math.min(Math.floor(fy), ny - 2), z0 = Math.min(Math.floor(fz), nz - 2)
    const tx = fx - x0, ty = fy - y0, tz = fz - z0
    lobe.fill(0)
    for (let corner = 0; corner < 8; corner++) {
      const weight = (corner & 1 ? tx : 1 - tx) * (corner & 2 ? ty : 1 - ty) * (corner & 4 ? tz : 1 - tz)
      if (weight === 0) continue
      const texel = (x0 + (corner & 1) + nx * (y0 + (corner >> 1 & 1) + ny * (z0 + (corner >> 2)))) * 4
      for (let f = 0; f < 6; f++) for (let c = 0; c < 3; c++) lobe[f * 3 + c] += volumes[f][texel + c] * weight
    }
    for (let f = 0; f < 6; f++) grade(lobe, f * 3, x, z)
    let peak = 0
    for (let k = 0; k < 18; k++) peak = Math.max(peak, lobe[k] = Math.min(lobe[k], FIELD_LIMIT))
    // multiplier = FIELD_LIMIT * (byte / 255)^4: the fourth root reaches from the lamps' glare down to the faintest bounce
    const step = Math.min(255, Math.ceil((peak / FIELD_LIMIT) ** .25 * 255)), unit = FIELD_LIMIT * (step / 255) ** 4
    for (let f = 0; f < 6; f++) for (let c = 0; c < 3; c++) out[at + f * 4 + c] = unit > 0 ? Math.round(Math.sqrt(lobe[f * 3 + c] / unit) * 255) : 0
    out[at + 3] = step
  }
}

// How strongly the leaf texture's relief (the x of its tangent-space normal) modulates the light on near
// leaves, mid sprays and far sprays. The cards have no usable tangent frame, so the relief only brightens and darkens.
const RELIEF = [.3, .2, .18]
// Width of the moon's highlight on near leaves (GGX alpha). It is worked out at the card corners, so it is
// kept broad enough to survive the interpolation between them.
const SHEEN_WIDTH = .3

// Leaves. All light is worked out at the card corners, for both faces, and the pixel picks the face it sees:
//   near leaves and mid sprays  sky fill and moonlight by the corner's normal, the moon dimmed by how much of it
//                               reaches the card through the canopy (stored per card by foliage_pack.py), and the
//                               baked lamp light; near leaves also a broad highlight of the moon;
//   far sprays                  Bruno's inexpensive normal-based ramp, plus the baked lamp light.
// A pixel reads the colour map and, if the cut-out keeps it, the detail map. No live light, shadow lookup or
// normal mapping: on integrated graphics those were the largest cost of the whole frame.
// reach: how far a card's corners lie from its place, at scale 1.
function material(assets, level, world, range, viewPosition, nearShare, reach) {
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, alphaTest: .4 }), manifest = assets.manifest
  const P = world.palette, SKY_FILL = P.skyFill, MOON_SHADOW = P.moon.shadow, L = P.leaves, G = P.glow
  const place = attribute('leafPlace', 'vec4'), turn = attribute('leafTurn', 'vec4')          // position and scale; rotation
  // Six byte quadruples: rgb is the baked lamp light arriving from +x, -x, +y, -y, +z, -z (fieldEncoder);
  // the fourth bytes are its multiplier, the moonlight and the sky reaching the card, variation, glow and phase.
  const lobes = [0, 1, 2, 3, 4, 5].map((i) => attribute('leafLight' + i, 'vec4')), phase = lobes[5].a
  // From the corners to the pixel. front, back: the light on each face (rgb) and the moonlight coming through
  // a leaf seen from its far side (a). extra: glow, then the moon highlight on the front and on the back.
  const front = varyingProperty('vec4', 'leafFront'), back = varyingProperty('vec4', 'leafBack'), extra = varyingProperty('vec3', 'leafExtra')
  const direction = new THREE.Vector3(...world.meta.moon.direction_to_scene).normalize()
  const moon = vec3(direction.x, direction.y, direction.z), towardMoon = moon.negate()        // moon: travelling from the moon to the scene
  const moonColor = vec3(...world.meta.moon.color)

  // Which level draws a card is decided per card, not per pixel: each has a phase and is drawn by the level
  // whose share of the cross-fade its phase falls in. Distance is measured to the card's block, and a mid spray
  // has the phase of the near leaves it stands for (foliage_pack.py): as the camera comes closer a spray gives
  // way to exactly its own leaves, a few sprays of the block at a time, and no pixel is shaded twice.
  const distance = length(place.xyz.div(BLOCK).floor().add(.5).mul(BLOCK).sub(viewPosition)).sub(BLOCK_RADIUS).max(0)
  const near = smoothstep(range.near[0], range.near[1], distance), far = smoothstep(range.far[0], range.far[1], distance)
  // nearShare (0 to 1): how much of their range the near leaves have taken over. 0 until their data has arrived
  // after the scene appeared (the mid sprays then draw close up too); it then rises in about 1.5 s, so the near
  // leaves replace their sprays card by card, by phase, as at a change of level.
  const nearLimit = near.oneMinus().mul(nearShare)
  const low = level === 0 ? float(0) : level === 1 ? nearLimit : far.oneMinus()
  const high = level === 0 ? nearLimit : level === 1 ? far.oneMinus() : float(1)
  let drawn = phase.greaterThanEqual(low).and(phase.lessThan(high))
  // In the pond's reflection the far cards stand in for every tree (near levels are skipped there).
  if (level === 2) drawn = drawn.or(reflectionPass.greaterThan(.5))
  // Nor is a card lit that lies wholly outside the view of this render (the camera's, or the pond mirror's, whose
  // projection differs only in its near side, the water): its sphere, the corners' reach at its scale and its flutter,
  // against the view's four sides, |x| < w + r sqrt(p00² + 1) in clip space and so for y (the grass's per-tuft test,
  // made exact for a sphere).
  if (!LIGHT_ALL) {
    const clip = cameraProjectionMatrix.mul(modelViewMatrix.mul(vec4(place.xyz, 1))), r = place.w.mul(reach).add(.02)
    const within = (axis, scale) => clip[axis].abs().lessThan(clip.w.add(r.mul(length(vec2(scale, 1)))))
    drawn = drawn.and(within('x', cameraProjectionMatrix.element(0).element(0))).and(within('y', cameraProjectionMatrix.element(1).element(1)))
  }

  m.positionNode = Fn(() => {
    // A card that another level draws stays collapsed in a point and skips everything below: at the edge of
    // a level's range that is most of the cards of a cell.
    const position = vec3(0).toVar()
    If(drawn, () => {
      const turned = (v) => v.add(cross(turn.xyz, cross(turn.xyz, v).add(v.mul(turn.w))).mul(2))
      const origin = turned(positionGeometry.mul(place.w)).add(place.xyz), n = turned(normalGeometry)
      const reaching = mix(1, lobes[1].a, MOON_SHADOW), variety = lobes[3].a
      // Canopy glow: glow.canopyGain everywhere, easing to glow.canopyFar times that beyond glow.canopyRange
      // metres from the statue, so the strongest pink stays around it.
      let glow = lobes[4].a.mul(manifest.glow_strength * G.canopyGain)
      if (G.canopyFar !== 1 && world.statue) glow = glow.mul(mix(1, G.canopyFar,
        smoothstep(G.canopyRange[0], G.canopyRange[1], length(place.xz.sub(vec3(world.statue.base.x, 0, world.statue.base.z).xz)))))
      // Depth inside a crown (leaves.depth): cards the sky reaches less than the average card darken toward
      // leaves.depthTint, those it reaches more brighten, so a canopy has a lit outside and a deep inside.
      const depth = L.depth ? mix(vec3(1), mix(vec3(...L.depthTint).mul(.35), vec3(1.5), lobes[2].a.div(L.depthMean * 2).clamp()), L.depth) : null
      const lampScale = lobes[0].a.mul(lobes[0].a).pow(2).mul(FIELD_LIMIT)
      const lampLight = (normal) => {
        const toward = normal.max(0), away = normal.negate().max(0)
        // each direction counts by the square of the normal's component along it, as in fieldLobes()
        const parts = [toward.x, away.x, toward.y, away.y, toward.z, away.z].map((weight, i) => lobes[i].rgb.mul(weight))
        return parts.reduce((sum, part) => sum.add(part.mul(part)), vec3(0)).mul(lampScale)
      }
      const through = dot(n, moon)
      if (level < 2) {
        const moonLight = moonColor.mul(world.meta.moon.strength / Math.PI).mul(reaching)
        const sky = vec3(...SKY_FILL.sky).mul(SKY_FILL.intensity / Math.PI), ground = vec3(...SKY_FILL.ground).mul(SKY_FILL.intensity / Math.PI)
        const lamp = lampLight(n), variation = variety.mul(.4).add(.8)    // the same lamp light on both faces: leaves let it through
        const shade = depth ? variation.mul(depth) : variation
        const lit = (normal) => mix(ground, sky, normal.y.mul(.5).add(.5)).add(moonLight.mul(dot(normal, towardMoon).max(0))).add(lamp).mul(shade)
        front.assign(vec4(lit(n), through.max(0).pow(2))); back.assign(vec4(lit(n.negate()), through.negate().max(0).pow(2)))
        if (level === 0) {
          // Sprays get no highlight: one worked out at the corners of so large a card turns the whole spray pale.
          const view = normalize(cameraPosition.sub(origin)), half = normalize(view.add(towardMoon)), a2 = SHEEN_WIDTH ** 2
          const fresnel = dot(view, half).oneMinus().max(0).pow(5).mul(.96).add(.04)
          const highlight = (normal) => {                                 // GGX, as the standard material's
            const nl = dot(normal, towardMoon).max(0), nv = dot(normal, view).max(.05), nh = dot(normal, half).max(0)
            const spread = nh.mul(nh).mul(a2 - 1).add(1)
            const masking = nl.mul(sqrt(nv.mul(nv).mul(1 - a2).add(a2))).add(nv.mul(sqrt(nl.mul(nl).mul(1 - a2).add(a2)))).max(1e-4)
            return nl.mul(a2 / Math.PI * .5).div(spread.mul(spread).mul(masking)).mul(fresnel).mul(reaching).mul(world.meta.moon.strength)
          }
          extra.assign(vec3(glow, highlight(n), highlight(n.negate())))
        } else extra.assign(vec3(glow, 0, 0))
      } else {
        const variation = variety.mul(.4).add(.75), lamp = lampLight(normalize(n.add(vec3(0, .5, 0))))   // lifted toward the sky
        const shade = depth ? variation.mul(depth) : variation
        const ramp = (normal) => vec3(...L.farBase).add(moonColor.mul(dot(normal, towardMoon).mul(.5).add(.5).clamp().mul(P.moon.farLeaves * P.moon.gain))).mul(shade).add(lamp)
        front.assign(vec4(ramp(n), through.max(0).pow(2))); back.assign(vec4(ramp(n.negate()), through.negate().max(0).pow(2)))
        extra.assign(vec3(glow, 0, 0))
      }
      const breeze = sin(time.mul(.7).add(place.x.mul(.31)).add(place.z.mul(.23))).mul(.012)
      const flutter = sin(time.mul(1.6).add(variety.mul(6.283)).add(place.y.mul(9))).mul(.004).add(breeze)    // each leaf on its own
      // Height within the card's atlas tile: 0 at the stem, 1 at the tip.
      const stemWeight = uv().y.sub(level === 0 ? 0 : .5).mul(2).pow(2)
      position.assign(origin.add(vec3(flutter.mul(stemWeight), 0, flutter.mul(stemWeight).mul(.5))))
    })
    return position
  })()

  const face = frontFacing.select(front, back), albedo = texture(assets.textures.color)
  m.opacityNode = albedo.a
  const detailMap = assets.textures.detail, detailSize = detailMap.image?.width ?? 1024
  m.colorNode = Fn(() => {
    // About four of every five pixels of a spray card are cut away: those stop after the colour map. The branch
    // hides the screen-space derivatives the second lookup needs for its mip level, so they are taken before it,
    // and the mip level is worked out from them there: reading at a given level is the fast path on integrated
    // graphics; reading with explicit gradients (as before, ?treeLegacy=leafDetail) is the slow one.
    const du = dFdx(uv()).toVar(), dv = dFdy(uv()).toVar(), color = vec3(0).toVar()
    const lod = legacy('leafDetail') ? null : max(dot(du, du), dot(dv, dv)).mul(detailSize * detailSize).max(1e-12).log2().mul(.5).max(0).toVar()
    If(albedo.a.greaterThan(.4), () => {
      // relief, glow mask, thickness, occlusion
      const detail = lod ? texture(detailMap, uv()).level(lod) : texture(detailMap, uv()).grad(du, dv)
      const relief = detail.r.mul(2).sub(1), thickness = detail.b
      const glow = () => {
        const glowMask = level === 0 ? float(1) : detail.g.greaterThan(.5).select(1.666667, 0)
        const glowDetail = dot(albedo.rgb, vec3(.2126, .7152, .0722)).mul(5).add(.28).clamp(.4, 1.15).mul(thickness.mul(.9).add(.35))
        return vec3(...manifest.glow_color).mul(extra.x).mul(glowMask).mul(glowDetail)
      }
      const shaded = albedo.rgb.mul(detail.a)                             // occlusion: baked overlap of the leaves in a spray
      let lit = shaded.mul(face.rgb).mul(relief.mul(RELIEF[level]).add(1))
        .add((level < 2 ? albedo.rgb : shaded).mul(face.a).mul(thickness).mul(L.through))
      if (legacy('leafGlow')) lit = lit.add(glow())
      if (level === 0) lit = lit.add(moonColor.mul(frontFacing.select(extra.y, extra.z)).mul(relief.add(1)))
      color.assign(lit)
      // The canopy glow, only on cards that have some (a card's glow is the same over the whole card).
      if (!legacy('leafGlow')) If(extra.x.greaterThan(0), () => { color.addAssign(glow()) })
    })
    return color
  })()
  return m
}

export class TreeSystem {
  constructor(assets, world, tier) {
    this.assets = assets; this.group = new THREE.Group(); this.group.name = 'OptimizedTrees'
    this.group.add(assets.wood)
    const woodMaterials = new Map()
    // Low-poly bark tubes and alpha twig cards (blender/scripts/foliage_wood_export.py): the
    // tiling PBR sets plus each family's baked AO atlas carry the detail the geometry no longer has.
    // Each family comes in a few chunks of whole trees (trees.json wood_parts), so three leaves out, view by view
    // (the pond's mirror included), the chunks whose bounds are out of it.
    this.wood = []
    assets.wood.traverse((o) => {
      if (!o.isMesh) return
      this.wood.push(o)
      // Drawn after the leaves (update() numbers the leaf cells 1 to 31 by distance): the leaves are cheap to
      // shade and the bark is not, so the bark hidden behind them should be rejected by depth, not the other way round.
      o.renderOrder = 35
      // WebGPU has no scalar 16-bit vertex format (Meshopt quantizes the glow weight); expand once.
      for (const [key, a] of Object.entries(o.geometry.attributes)) {
        if ((a.isInterleavedBufferAttribute ? a.data.array : a.array) instanceof Float32Array || a.itemSize !== 1) continue
        o.geometry.setAttribute(key, new THREE.Float32BufferAttribute(Float32Array.from({ length: a.count }, (_, i) => a.getX(i)), 1))
      }
      const glowKey = Object.keys(o.geometry.attributes).find((key) => key.toLowerCase() === '_branchglow')
      const family = o.material.name.replace(/^WEB_/, ''), hero = family.startsWith('Hero'), twigs = family.endsWith('Twigs')
      // The Far family: the trees on the sides the opening view never shows, 17 m and more from the statue
      // (blender/scripts/mf_orbit_extension.py). They have no baked atlas: bark and twigs alike take their light
      // from the grid at the vertices, which is all a trunk needs at that distance.
      const far = family.startsWith('Far'), grid = twigs || far
      // The tangent frame for the normal map, worked out once here: without it three rebuilds it for every pixel
      // from screen derivatives (Tangent.js uses the attribute when the geometry has one). Far bark reads no normal map.
      if (!legacy('tangents') && !far && !o.geometry.attributes.tangent) o.geometry.computeTangents()
      if (!woodMaterials.has(family)) woodMaterials.set(family, pbrMaterial(world, {
        name: family, set: twigs ? 'twig' : 'bark', alpha: twigs, grounded: !twigs,
        // Bark has its light in its family's atlas; twig cards take theirs from the light grid, moon included,
        // read at their corners (the grid's cells are metres wide, a twig card centimetres).
        light: grid ? 'canopy' : hero ? 'wood_hero' : 'wood_bg', vertexLight: grid && !(twigs && legacy('twigLight')),
        macroAO: grid ? null : world.pbr.macro[hero ? 'wood_ao_hero' : 'wood_ao_bg'],
        moss: twigs ? 0 : .6, glowKey: hero && !twigs ? glowKey : null,
        // The moon's highlight stays on bark: without it thin branches lose small glints (seen at 2x zoom,
        // 2026-11-12), for no measurable gain.
        cheapReflection: !twigs && !legacy('reflection'),
      }))
      o.material.dispose(); o.material = woodMaterials.get(family)
    })
    this.viewPosition = uniform(new THREE.Vector3()); this.range = lodRange(tier)
    this.nearShare = uniform(0)                                          // see material(): 0 until the near leaves are in
    this.viewpoint = new THREE.Vector3(...world.meta.camera_reference.position)
    // The camera's path and the statue the swing measures its reach from (queueWay); the near cells queued.
    this.path = world.cameraPath; this.statueCentre = world.statue?.centre ?? null; this.queuedTo = null; this.queued = new Set()
    this.shapes = [0, 1, 2].map((level) => [0, 1].map((species) => geometry(assets.manifest, species, level)))
    const reach = this.shapes.map((pair) => Math.max(...pair.map(({ boundingSphere: s }) => s.center.length() + s.radius)))
    this.materials = [0, 1, 2].map((level) => material(assets, level, world, this.range, this.viewPosition, this.nearShare, reach[level]))
    this.encodeField = fieldEncoder(world)
    this.levels = assets.levels.map((records, level) => records ? { records, ...cellsOf(records, CELL_BLOCKS[level]) } : { records: null, order: null, cells: [] })
    // The near leaves come later (loadNear). One near-leaf card, made from a mid spray's record, is drawn behind the
    // loading screen only, so the near level's shaders and pipeline exist before its data does (nothing of it shows:
    // with nearShare 0 the card stays collapsed).
    this.warmMesh = this.warmupCard()
    for (const level of [1, 2]) {
      for (const cell of this.levels[level].cells) this.build(level, cell)
      this.levels[level].records = this.levels[level].order = null      // the GPU buffers hold them now
    }
    assets.levels = null
    this.near = { entry: assets.manifest.levels[0], grid: assets.manifest.grid, state: tier.label === 'Low' ? 'disabled' : 'waiting', worker: null, blendStart: 0 }
    // The desktop textures that follow the reveal wait for the near leaves: those are what the first seconds show.
    this.releaseLate = holdLate(() => !['done', 'failed', 'disabled'].includes(this.near.state))
    // For the checks in scripts/perf (leaf-levels.mjs repeats the level rule with these).
    const self = this
    if (import.meta.env.DEV) this.group.userData.leaves = { textures: assets.textures, levels: this.levels, range: this.range, block: { size: BLOCK, radius: BLOCK_RADIUS },
      get nearShare() { return self.nearShare.value }, set nearShare(value) { self.nearShare.value = value },   // tests may hold a share
      get nearState() { return self.near.state } }
    this.frustum = new THREE.Frustum(); this.matrix = new THREE.Matrix4(); this.stats = {}
  }

  warmupCard() {
    const source = this.levels[1], i = source.order[0], at = new THREE.Vector3().fromArray(source.records.position, i * 3)
    const cell = { species: source.records.species[i], count: 1, start: 0, reach: source.records.scale[i], box: new THREE.Box3(at.clone(), at.clone()), blocks: [], mesh: null }
    const near = this.levels[0]
    this.levels[0] = { records: source.records, order: Uint32Array.of(i), cells: [] }
    this.build(0, cell)
    this.levels[0] = near
    cell.mesh.name = 'Foliage_LOD0_warmup'; cell.mesh.visible = false; cell.mesh.frustumCulled = false
    return cell.mesh
  }

  // The near leaves, after the scene appeared: fetched, unpacked and grouped in a worker (nearLeaves.worker.js),
  // so the main thread never stalls on their 211,401 records. Their cells are then built as the camera nears them,
  // and once those in range exist, nearShare rises and the near leaves take over from the sprays.
  loadNear() {
    this.near.state = 'loading'
    const worker = this.near.worker = new Worker(new URL('./nearLeaves.worker.js', import.meta.url), { type: 'module' })
    const fail = (message) => { console.error('Near leaves unavailable:', message); this.near.state = 'failed'; worker.terminate(); this.near.worker = null }
    worker.onerror = (event) => fail(event.message)
    worker.onmessage = ({ data }) => {
      worker.terminate(); this.near.worker = null
      if (this.disposed) return
      if (data.error) { fail(data.error); return }
      Object.assign(this.levels[0], { records: data.records, sorted: true, ...asCells({ cells: data.cells, order: data.order }) })
      this.near.state = 'arrived'
    }
    const { entry, grid } = this.near
    worker.postMessage({ url: new URL('/' + entry.file, location.href).href, count: entry.count, grid, size: BLOCK, blocks: CELL_BLOCKS[0], from: this.viewpoint.toArray() })
  }

  // The instance buffers and mesh of one cell, 48 bytes per card:
  //   leafPlace  position, scale (floats)          leafTurn  rotation quaternion (16-bit)
  //   leafLight0 to 5  bytes, in one buffer: the lamp light from six directions and six single values (see material())
  // Cards are prepared until performance.now() passes `until` (checked every 128 cards), so a full block of near
  // leaves takes several frames; the mesh exists once all are.
  build(level, cell, until = Infinity) {
    const { records, order, sorted } = this.levels[level], shape = this.shapes[level][cell.species], count = cell.count
    if (!cell.work) {
      // Cards nearest the scene's reference viewpoint first (lod.js; the near leaves come sorted from their worker).
      if (!sorted) nearestFirst(order, cell.start, count, records.position, this.viewpoint.toArray())
      cell.work = { members: order.subarray(cell.start, cell.start + count), done: 0,
        place: new Float32Array(count * 4), turn: new Int16Array(count * 4), bytes: new Uint8Array(count * 24) }
    }
    const { members, place, turn, bytes } = cell.work, start = cell.work.done
    let end = count
    for (let k = start; k < count; k++) {
      if (k > start && (k - start) % 128 === 0 && performance.now() > until) { end = k; break }
      const i = members[k], x = records.position[i * 3], y = records.position[i * 3 + 1], z = records.position[i * 3 + 2]
      place[k * 4] = x; place[k * 4 + 1] = y; place[k * 4 + 2] = z; place[k * 4 + 3] = records.scale[i]
      for (let c = 0; c < 4; c++) turn[k * 4 + c] = records.turn[i * 4 + c]
      const b = k * 24
      this.encodeField?.(x, y, z, bytes, b)                             // lamp light, and its multiplier in byte 3
      bytes[b + 7] = records.moon[i]; bytes[b + 11] = records.sky[i]; bytes[b + 15] = records.variation[i]
      bytes[b + 19] = Math.round(records.glow[i] * 255)
      bytes[b + 23] = records.phase[i] * 2                              // 0 to 254/255
    }
    cell.work.done = end
    if (end < count) return end - start
    cell.work = null
    const g = new THREE.InstancedBufferGeometry(), packed = new THREE.InstancedInterleavedBuffer(bytes, 24)
    g.setIndex(shape.index); for (const key of ['position', 'uv', 'normal']) g.setAttribute(key, shape.attributes[key])
    g.setAttribute('leafPlace', new THREE.InstancedBufferAttribute(place, 4))
    g.setAttribute('leafTurn', new THREE.InstancedBufferAttribute(turn, 4, true))
    for (let slot = 0; slot < 6; slot++) g.setAttribute('leafLight' + slot, new THREE.InterleavedBufferAttribute(packed, 4, slot * 4, true))
    g.instanceCount = count
    // Three would measure the single card: give it the cell's real extent (card positions plus their reach).
    const reach = (shape.boundingSphere.center.length() + shape.boundingSphere.radius) * cell.reach + .03
    g.boundingBox = cell.box.clone().expandByScalar(reach); g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere())
    const mesh = cell.mesh = new THREE.Mesh(g, this.materials[level])
    mesh.name = `Foliage_LOD${level}_${cell.start}`; mesh.matrixAutoUpdate = false
    mesh.userData.noReflection = level < 2
    mesh.userData.reflectionLod = level === 2   // Pond forces these visible while rendering its reflection
    cell.cardTriangles = shape.index.count / 3
    this.group.add(mesh)
    return end - start
  }

  // When the camera is sent somewhere new: every near cell not built yet that comes within AHEAD of its range anywhere
  // on the way (eyes along the path, each with the swing's sideways reach there, parallax.js) is built from now on,
  // nearest first, within BUILD_MS a frame, so they are ready before the camera arrives (or nearly: a jump such as
  // the End key can still outrun the slices).
  queueWay(from, to) {
    const cells = this.levels[0].cells, eye = new THREE.Vector3(), turn = new THREE.Quaternion(), centre = this.statueCentre
    const eyes = Math.max(1, Math.ceil(Math.abs(to - from) * EYES_PER_ORBIT))
    for (let s = 0; s <= eyes; s++) {
      this.path.poseAt(from + (to - from) * s / eyes, eye, turn)
      const reach = this.range.near[1] + AHEAD + swingReach(centre ? Math.min(12, eye.distanceTo(centre)) : 12).side
      for (const cell of cells) if (!cell.mesh && !this.queued.has(cell) && cell.blocks.some((block) => eye.distanceTo(block) - BLOCK_RADIUS < reach)) this.queued.add(cell)
    }
  }

  update(camera) {
    this.viewPosition.value.copy(camera.position)
    this.frustum.setFromProjectionMatrix(this.matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse), camera.coordinateSystem)
    const eye = camera.position, { near, far } = this.range, edge = .02, frustum = this.frustum
    if (this.near.state === 'waiting' && (this.page ??= document.querySelector('.experience'))?.dataset.phase === 'ready') this.loadNear()
    // Scrolled somewhere new (scroll.js; the camera rides the path unless ?orbit): queue the near cells on the way
    // there, once they have arrived.
    const to = ORBIT || !this.path ? null : scroll.target
    // (already there: put there at once, or "Back to start" landing on 1 = 0, the same pose)
    if (to !== null && to !== this.queuedTo && this.levels[0].cells.length) { if (to !== scroll.eased) this.queueWay(this.queuedTo ?? scroll.eased, to); this.queuedTo = to }
    // Behind the loading screen every wood chunk is drawn, so each one's pipeline exists before it comes into view.
    for (const o of this.wood) o.frustumCulled = !warmup.active && !WOOD_WHOLE
    if (this.warmMesh) {
      this.warmMesh.visible = warmup.active
      if (warmup.active) this.warmSeen = true
      else if (this.warmSeen) { this.group.remove(this.warmMesh); this.warmMesh.geometry.dispose(); this.warmMesh = null }
    }
    // Until the near leaves have taken over, the mid sprays are drawn close up as well.
    const sprayNear = this.nearShare.value < 1
    // Near cells not built yet, with how near they are; at rest (the near leaves in), all of them.
    const wanted = [], idle = this.near.state === 'done' && !scroll.moving
    let triangles = 0, draws = 0, instances = 0, meshes = 0, pending = false, unbuilt = 0
    this.levels.forEach(({ cells }, level) => {
      cells.forEach((cell, index) => {
        // The nearest and the farthest of the cell's blocks, as the shader measures them.
        let nearest = Infinity, farthest = 0
        for (const block of cell.blocks) {
          const distance = Math.max(0, eye.distanceTo(block) - BLOCK_RADIUS)
          nearest = Math.min(nearest, distance); farthest = Math.max(farthest, distance)
        }
        // A cell is drawn while any of its blocks can be at this level; the shader decides card by card.
        let visible = level === 0 ? nearest < near[1] + edge : level === 1 ? (farthest > near[0] - edge || sprayNear) && nearest < far[1] + edge : farthest > far[0] - edge
        // Distant leaf cells can be omitted smoothly as fog conceals them.
        if (nearest > 25 + adaptive.foliageScale * 35) visible = false
        // Behind the loading screen every cell that exists is drawn (and casts) for a few frames, with one cell
        // of near leaves: the pipelines of all three levels then exist before the first camera move.
        if (warmup.active) visible = visible || level > 0 || index === 0
        if (!cell.mesh) {                                               // near leaves only
          if (visible) { pending = true; if (this.nearShare.value > 0) unbuilt += cell.count }   // in range and not built yet
          const needed = visible || nearest < near[1] + AHEAD || this.queued.has(cell)
          if (needed || idle) wanted.push({ cell, visible, rank: needed ? nearest : 1e6 + nearest })
          return
        }
        place(cell, visible)
      })
    })
    // Near cells first (the cells needed, then those for later), for this frame's time.
    if (wanted.length) {
      const until = performance.now() + (wanted.some((w) => w.rank < 1e6) ? BUILD_MS : IDLE_MS)
      wanted.sort((a, b) => a.rank - b.rank)
      for (const { cell, visible } of wanted) {
        this.build(0, cell, until)
        if (!cell.mesh) break
        this.queued.delete(cell); place(cell, visible)
        if (performance.now() > until) break
      }
    }
    function place(cell, visible) {
      const mesh = cell.mesh
      mesh.visible = visible; mesh.frustumCulled = !warmup.active
      // Near cells are drawn before far ones, so leaves hidden behind nearer leaves are rejected by depth
      // before they are shaded. (The cards of a cell share one prototype, which gives three nothing to sort by.)
      mesh.renderOrder = 1 + Math.min(30, Math.floor(cell.box.distanceToPoint(eye) / 3))
      meshes++
      if (visible && frustum.intersectsSphere(mesh.geometry.boundingSphere)) { triangles += cell.cardTriangles * cell.count; draws++; instances += cell.count }
    }
    // The near leaves take over once every near cell in range is built: no gap while the sprays give way.
    if (this.near.state === 'arrived' && !pending) { this.near.state = 'blending'; this.near.blendStart = performance.now() }
    if (this.near.state === 'blending') {
      this.nearShare.value = Math.min(1, (performance.now() - this.near.blendStart) / 1500)
      if (this.nearShare.value === 1) this.near.state = 'done'
    }
    // unbuilt: near leaves in range whose cell is not built yet while the near level draws (their sprays have given
    // way): cards missing from this frame.
    this.stats = { triangles, draws, instances, cells: meshes, originalTriangles: this.assets.manifest.original_leaf_triangles, unbuilt, queued: this.queued.size }
  }

  dispose() {
    this.disposed = true; this.near.worker?.terminate(); this.near.worker = null; this.releaseLate()
    this.warmMesh?.geometry.dispose()
    for (const { cells } of this.levels) for (const cell of cells) cell.mesh?.geometry.dispose()
    this.shapes.flat().forEach((g) => g.dispose())
    this.materials.forEach((m) => m.dispose()); disposeObject(this.assets.wood); Object.values(this.assets.textures).forEach((t) => t.dispose()); this.group.clear()
  }
}
