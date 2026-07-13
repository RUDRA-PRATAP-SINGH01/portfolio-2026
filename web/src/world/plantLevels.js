import * as THREE from 'three/webgpu'
import { warmup } from '../loading/warmup.js'

// Lighter levels of the heavy plants (blender/scripts/web_lod.py; a prototype's `lod` list in scene.json).
// A copy is drawn with the full mesh close up and with a lighter one beyond each level's distance: metres for a
// copy at scale 1 in the reference camera's view 900 pixels high, scaled here with the copy's size, the canvas
// height and the field of view, so a level always takes over at the same size on screen (where it is within
// about 1.5 pixels of the full mesh). Measured on the Intel laptop (2026-11-12): plants cost by their triangles, at
// any resolution; with levels the main view's ferns and periwinkles are 67k triangles instead of 567k, and the
// frame 1.2 ms shorter.
// Copies are re-sorted into their levels when the camera has moved a quarter of a metre. A copy changes level
// 6% beyond a distance and changes back 6% before it, so it does not flicker between two at the border.
// Every plant kind not afloat comes through here, with levels or without, and only the copies that can be seen are
// sent (a kind used to be sent whole whenever one copy touched the view, and again for the pond's mirror). A copy is
// kept while its sphere, or for the kinds the mirror shows its image in the water (the mirror's camera is the view
// reflected in the water plane, Pond.jsx), reaches into the view widened by what the camera may still move (STEP)
// and turn (TURN) before the next re-sort; one comes as soon as it has moved or turned that far (the scroll path and
// the pointer swing turn the view), or its projection changes. One list serves both passes: it holds both views.
const HYSTERESIS = .06, STEP = .25, TURN = 2.5 * Math.PI / 180

const query = import.meta.env?.DEV && typeof location !== 'undefined' ? new URLSearchParams(location.search) : null
// ?plantLod=<n> (development): every copy at level n (0 = the full mesh everywhere), for comparisons.
const FORCED = query?.get('plantLod') ?? null
// ?cullLegacy (development): every copy sent, seen or not, as before. =plants for this part alone (=leaves: the leaf
// cards' part, trees/TreeSystem.js).
const cull = query?.get('cullLegacy')
const SEND_ALL = cull != null && (cull === '' || cull.split(',').includes('plants'))

// Whether a sphere (x, y, z, r) can reach into the view of a camera up to STEP from `eye` and turned up to TURN from
// the view whose four sides are `sides` (inward unit normal and constant, four numbers each). Such a turn moves a
// side's normal by at most TURN, so each side gives way by TURN times the distance, besides the move and the radius.
function reaches(sides, eye, x, y, z, r) {
  const dx = x - eye.x, dy = y - eye.y, dz = z - eye.z
  const slack = (r + STEP) * (1 + TURN) + TURN * Math.sqrt(dx * dx + dy * dy + dz * dz)
  for (let k = 0; k < 16; k += 4) if (sides[k] * x + sides[k + 1] * y + sides[k + 2] * z + sides[k + 3] < -slack) return false
  return true
}

const _sphere = new THREE.Sphere()
// Copy i of a set into the next free place of level l's mesh, with everything that goes with it. Plain loops and
// sums: a re-sort can refill every kind, and with subarray() and Sphere.union() one took 0.22 ms instead of 0.13.
const copy = (from, i, to, k, n) => { for (let j = 0; j < n; j++) to[k * n + j] = from[i * n + j] }
function put(set, l, i) {
  const mesh = set.meshes[l], k = set.filled[l]++, s = set.spheres[l]
  copy(set.matrices[l], i, mesh.instanceMatrix.array, k, 16)
  copy(set.colors, i, mesh.instanceColor.array, k, 3)
  for (const { attribute, source } of set.extras[l]) copy(source, i, attribute.array, k, attribute.itemSize)
  // the mesh's bounds take in the copy's sphere: the smallest sphere round both, as Sphere.union
  const b = mesh.boundingSphere, c = b.center, x = s[i * 4], y = s[i * 4 + 1], z = s[i * 4 + 2], r = s[i * 4 + 3]
  if (b.radius < 0) { c.set(x, y, z); b.radius = r; return }
  const dx = x - c.x, dy = y - c.y, dz = z - c.z, d = Math.sqrt(dx * dx + dy * dy + dz * dz)
  if (d + r <= b.radius) return
  if (d + b.radius <= r) { c.set(x, y, z); b.radius = r; return }
  const R = (d + b.radius + r) / 2, t = (R - b.radius) / d
  c.x += dx * t; c.y += dy * t; c.z += dz * t; b.radius = R
}

// The lighter levels' meshes for one part (a Mesh of the prototype, one per material) of a prototype, nearest first.
// `lod` is its scene.json list, `find` looks a level's node up by name. A level of a plant with several materials
// (sprays, geraniums) lists the `parts` it has, one per material it keeps: the part is drawn with the level's part of
// the same material, or not at all at that level (null). The wiry stems a level leaves out stay whole: without them
// the sprays beside the statue lost the dark strokes that draw them against the sky in the opening view (2026-11-17).
const KEEP_WHOLE = /Stem/
export function levelParts(lod, find, part) {
  return (lod ?? []).map(level => {
    const node = find(level.name), parts = node?.isMesh ? [node] : node?.children.filter(child => child.isMesh) ?? []
    if (!parts.length) throw new Error(`Missing lighter level ${level.name}`)
    if (!level.parts) return parts[0]
    return parts.find(own => own.material.name === part.material.name) ?? (KEEP_WHOLE.test(part.material.name) ? part : null)
  })
}

export function plantLevels(world, forced = FORCED, sendAll = SEND_ALL) {
  const sets = [], last = new THREE.Vector3(Infinity, 0, 0), turn = new THREE.Quaternion(), projection = new Float64Array(16)
  const referencePixel = Math.tan(THREE.MathUtils.degToRad(world.meta.camera_reference.vertical_fov_deg) / 2) / 900
  const frustum = new THREE.Frustum(), view = new THREE.Matrix4(), sides = new Float64Array(16), water = world.meta.water_level
  let height = 0, warm = null
  return {
    sets,
    // full: the InstancedMesh holding every copy with the full mesh; entry: the prototype's manifest entry (instances,
    // lod); lighter: the lighter levels' meshes as loaded, nearest first (none for a kind without levels). Each level
    // has its own node matrix (the file stores every mesh in its own quantised box), so each has its own set of copy
    // matrices. A plant of several materials comes as one set per part (its full mesh's part, and each level's part of
    // the same material); a level without this part is null, and copies at that level draw nothing of it. The parts'
    // sets choose the same level for a copy: the same distances, the same camera, the same history.
    // Returns the new meshes, for the caller to add to the scene.
    add(full, entry, lighter) {
      const n = entry.instances.length, matrix = new THREE.Matrix4()
      const matrices = [full.instanceMatrix.array.slice()], colors = full.instanceColor.array.slice()
      const meshes = [full, ...lighter.map((source, k) => {
        if (!source) { matrices.push(null); return null }
        const mesh = new THREE.InstancedMesh(source.geometry, full.material, n)
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3)
        mesh.name = `${full.name}_lod${k + 1}`; mesh.matrixAutoUpdate = false; mesh.renderOrder = full.renderOrder
        mesh.userData.noReflection = full.userData.noReflection
        mesh.count = 0; mesh.visible = false
        const own = new Float32Array(n * 16)
        entry.instances.forEach((instance, i) => matrix.fromArray(instance.matrix).multiply(source.matrixWorld).toArray(own, i * 16))
        matrices.push(own)
        return mesh
      })]
      // Each copy's sphere at each level (centre, radius), as three bounds an instanced mesh: what decides whether it
      // is sent, and what its mesh's bounds are made of.
      const spheres = meshes.map((mesh, l) => {
        if (!mesh) return null
        const { geometry } = mesh
        if (!geometry.boundingSphere) geometry.computeBoundingSphere()
        const own = new Float64Array(n * 4)
        for (let i = 0; i < n; i++) {
          _sphere.copy(geometry.boundingSphere).applyMatrix4(matrix.fromArray(matrices[l], i * 16))
          own[i * 4] = _sphere.center.x; own[i * 4 + 1] = _sphere.center.y; own[i * 4 + 2] = _sphere.center.z; own[i * 4 + 3] = _sphere.radius
        }
        return own
      })
      // Values the geometry holds per copy (a spray's flowerKeep and flowerFar) go where their copy goes.
      const extras = meshes.map(mesh => mesh ? Object.values(mesh.geometry.attributes).filter(a => a.isInstancedBufferAttribute).map(attribute => ({ attribute, source: attribute.array.slice() })) : [])
      sets.push({ meshes, beyond: (entry.lod ?? []).map(level => level.beyond), matrices, colors, spheres, extras, mirrored: !full.userData.noReflection,
        level: new Int8Array(n).fill(-1), shown: new Uint8Array(n), counts: [], filled: [],
        places: entry.instances.map(({ matrix: m }) => new THREE.Vector3(m[12], m[13], m[14])),
        scales: Float32Array.from(entry.instances, ({ matrix: m }) => Math.hypot(m[0], m[1], m[2])) })
      return meshes.slice(1).filter(Boolean)
    },
    update(camera, viewportHeight) {
      const now = camera.projectionMatrix.elements, eye = camera.position
      let still = height === viewportHeight && warm === warmup.active && last.distanceToSquared(eye) < STEP * STEP && turn.angleTo(camera.quaternion) < TURN
      for (let i = 0; i < 16 && still; i++) still = projection[i] === now[i]
      if (still) return
      last.copy(eye); turn.copy(camera.quaternion); projection.set(now); height = viewportHeight; warm = warmup.active
      frustum.setFromProjectionMatrix(view.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse), camera.coordinateSystem)
      for (let k = 0; k < 4; k++) { const { normal, constant } = frustum.planes[k]; sides[k * 4] = normal.x; sides[k * 4 + 1] = normal.y; sides[k * 4 + 2] = normal.z; sides[k * 4 + 3] = constant }
      // a copy's distance as the levels' distances mean it: by its size on screen
      const zoom = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / Math.max(1, viewportHeight) / referencePixel
      for (const set of sets) {
        const { meshes, beyond, level, shown, places, scales, spheres, mirrored } = set, n = level.length
        let changed = set.warm !== warm
        for (let i = 0; i < n; i++) {
          const d = eye.distanceTo(places[i]) / scales[i] * zoom
          let l = level[i]
          if (forced !== null) l = Math.min(Math.max(0, +forced || 0), beyond.length)
          else if (l < 0) { l = 0; while (l < beyond.length && d > beyond[l]) l++ }                       // first time: plainly by distance
          else {
            while (l < beyond.length && d > beyond[l] * (1 + HYSTERESIS)) l++
            while (l > 0 && d < beyond[l - 1] * (1 - HYSTERESIS)) l--
          }
          if (l !== level[i]) { level[i] = l; changed = true }
          const s = spheres[l], k = i * 4                                // (null: this part is not in the copy's level)
          const seen = s && (sendAll || reaches(sides, eye, s[k], s[k + 1], s[k + 2], s[k + 3]) || mirrored && reaches(sides, eye, s[k], 2 * water - s[k + 1], s[k + 2], s[k + 3])) ? 1 : 0
          if (seen !== shown[i]) { shown[i] = seen; changed = true }
        }
        if (!changed) continue
        set.warm = warm
        set.filled = meshes.map(mesh => { if (mesh) (mesh.boundingSphere ??= new THREE.Sphere()).makeEmpty(); return 0 })
        for (let i = 0; i < n; i++) if (shown[i]) put(set, level[i], i)
        set.counts = set.filled.slice()
        meshes.forEach((mesh, l) => {
          if (!mesh) return
          // Behind the loading screen every level is drawn once (one copy), so nothing is built at the first camera move.
          if (set.filled[l] === 0 && warm) put(set, l, 0)
          mesh.count = set.filled[l]; mesh.visible = mesh.count > 0
          mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor.needsUpdate = true
          for (const { attribute } of set.extras[l]) attribute.needsUpdate = true
          mesh.boundingBox = null                                      // (made again from the copies sent, should anything ask)
        })
      }
    },
  }
}
