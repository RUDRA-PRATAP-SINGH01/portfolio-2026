import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three/webgpu'
import { levelParts, plantLevels } from './plantLevels.js'
import { warmup } from '../loading/warmup.js'

const FOV = 44.37249608
const world = { meta: { camera_reference: { vertical_fov_deg: FOV }, water_level: -100 } }

// Copies along the x axis at the given distances from the origin, each of the given scale.
function plant(distances, scales = distances.map(() => 1), beyond = [9, 12.5, 21]) {
  const instances = distances.map((d, i) => ({ matrix: new THREE.Matrix4().makeScale(scales[i], scales[i], scales[i]).setPosition(d, 0, 0).toArray() }))
  const full = new THREE.InstancedMesh(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3)), new THREE.MeshBasicMaterial(), instances.length)
  instances.forEach((instance, i) => { full.setMatrixAt(i, new THREE.Matrix4().fromArray(instance.matrix)); full.setColorAt(i, new THREE.Color(i / 10, 0, 0)) })
  // each lighter level's node sits in its own box: here moved by k + 1 along y
  const lighter = beyond.map((_, k) => { const mesh = new THREE.Mesh(full.geometry.clone()); mesh.position.y = k + 1; mesh.updateMatrixWorld(); return mesh })
  return { full, entry: { instances, lod: beyond.map(distance => ({ beyond: distance })) }, lighter }
}
// A camera at (x, 0, 0) looking along +x, at the copies (a square view).
const camera = (x = 0, fov = FOV) => { const c = new THREE.PerspectiveCamera(fov); c.position.set(x, 0, 0); c.lookAt(x + 1, 0, 0); c.updateMatrixWorld(); return c }

test('copies are drawn at the level their distance, size and the view call for', () => {
  const levels = plantLevels(world, null), { full, entry, lighter } = plant([5, 10, 15, 30, 30], [1, 1, 1, 1, 2])
  const added = levels.add(full, entry, lighter)
  assert.equal(added.length, 3)
  levels.update(camera(), 900)
  const set = levels.sets[0]
  assert.deepEqual([...set.level], [0, 1, 2, 3, 2])                     // the copy twice as large counts as half as far
  assert.deepEqual(set.counts, [1, 1, 2, 1])
  assert.deepEqual(set.meshes.map(mesh => [mesh.count, mesh.visible]), [[1, true], [1, true], [2, true], [1, true]])
  // a view twice as high shows everything twice as large: every copy counts as half as far
  const tall = plantLevels(world, null), again = plant([5, 10, 15, 30, 30], [1, 1, 1, 1, 2]); tall.add(again.full, again.entry, again.lighter)
  tall.update(camera(), 1800)
  assert.deepEqual([...tall.sets[0].level], [0, 0, 0, 2, 0])
})

test('a copy keeps its level until it is 6% past a distance, both ways', () => {
  const levels = plantLevels(world, null), { full, entry, lighter } = plant([0])
  levels.add(full, entry, lighter)
  const at = distance => { levels.update(camera(-distance), 900); return levels.sets[0].level[0] }
  assert.equal(at(8), 0)
  assert.equal(at(9.3), 0)                                              // beyond 9 m, within 6%
  assert.equal(at(9.6), 1)
  assert.equal(at(8.7), 1)                                              // back inside 9 m, within 6%
  assert.equal(at(8.3), 0)
  assert.equal(at(40), 3)
})

test('each level draws a copy with its own node matrix, and with the copy\'s tint', () => {
  const levels = plantLevels(world, null), { full, entry, lighter } = plant([15, 5])
  levels.add(full, entry, lighter)
  levels.update(camera(), 900)
  const [near, , far] = levels.sets[0].meshes, matrix = new THREE.Matrix4(), colour = new THREE.Color()
  near.getMatrixAt(0, matrix); assert.deepEqual(new THREE.Vector3().setFromMatrixPosition(matrix).toArray(), [5, 0, 0])
  far.getMatrixAt(0, matrix); assert.deepEqual(new THREE.Vector3().setFromMatrixPosition(matrix).toArray(), [15, 2, 0])    // level 2's node is 2 up
  far.getColorAt(0, colour); assert.ok(Math.abs(colour.r - 0) < 1e-6)
  near.getColorAt(0, colour); assert.ok(Math.abs(colour.r - .1) < 1e-6)
})

test('a forced level applies to every copy', () => {
  const levels = plantLevels(world, '2'), { full, entry, lighter } = plant([1, 50])
  levels.add(full, entry, lighter)
  levels.update(camera(), 900)
  assert.deepEqual([...levels.sets[0].level], [2, 2])
  assert.deepEqual(levels.sets[0].meshes.map(mesh => mesh.visible), [false, false, true, false])
})

// A kind without levels: tiny copies at the given places, each tagged with its number in a value per copy (as a
// spray's flowerKeep), tinted by it.
function kind(places, mirrored = true) {
  const geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, .01, 0, 0, 0, .01, 0], 3))
  geometry.setAttribute('tag', new THREE.InstancedBufferAttribute(Float32Array.from(places, (_, i) => i), 1))
  const full = new THREE.InstancedMesh(geometry, new THREE.MeshBasicMaterial(), places.length)
  places.forEach((p, i) => { full.setMatrixAt(i, new THREE.Matrix4().makeTranslation(...p)); full.setColorAt(i, new THREE.Color(i / 10, 0, 0)) })
  full.userData.noReflection = !mirrored
  return { full, entry: { instances: places.map(p => ({ matrix: new THREE.Matrix4().makeTranslation(...p).toArray() })) }, lighter: [] }
}
const tags = mesh => Array.from(mesh.geometry.attributes.tag.array.subarray(0, mesh.count))
const sphereOf = p => new THREE.Sphere(new THREE.Vector3(p[0] + .005, p[1] + .005, p[2]), Math.SQRT2 * .005)
const exactView = c => new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse))

test('a copy is sent only while it can be in view, with its tint and its values per copy', () => {
  //            ahead       behind      far beside  just beside: in the margin   far above
  const places = [[10, 0, 0], [-10, 0, 0], [10, 0, 8], [10, 0, 4.35], [10, 9, 0]]
  const levels = plantLevels(world, null), { full, entry, lighter } = kind(places)
  assert.deepEqual(levels.add(full, entry, lighter), [])
  const c = camera()
  levels.update(c, 900)
  assert.ok(!exactView(c).intersectsSphere(sphereOf(places[3])))          // kept for what the camera may do next
  assert.deepEqual(tags(full), [0, 3])
  assert.ok(full.visible)
  const matrix = new THREE.Matrix4(), colour = new THREE.Color()
  full.getMatrixAt(1, matrix); assert.ok(new THREE.Vector3().setFromMatrixPosition(matrix).distanceTo(new THREE.Vector3(10, 0, 4.35)) < 1e-6)
  full.getColorAt(1, colour); assert.ok(Math.abs(colour.r - .3) < 1e-6)
  // its bounds are those of the copies sent
  assert.ok(full.boundingSphere.containsPoint(new THREE.Vector3(10, 0, 0)) && full.boundingSphere.containsPoint(new THREE.Vector3(10, 0, 4.35)))
  assert.ok(full.boundingSphere.radius < 2.2)
  // ?cullLegacy: every copy, in its own order
  const all = plantLevels(world, null, true), again = kind(places); all.add(again.full, again.entry, again.lighter)
  all.update(camera(), 900)
  assert.deepEqual(tags(again.full), [0, 1, 2, 3, 4])
})

test('the pond\'s mirror shows a kind by its copies\' images in the water', () => {
  // A copy above the view whose image in the water (y = 0) is in it.
  const pond = { meta: { ...world.meta, water_level: 0 } }, c = new THREE.PerspectiveCamera(FOV)
  c.position.set(0, 1, 0); c.lookAt(10, -1, 0); c.updateMatrixWorld()
  for (const mirrored of [true, false]) {
    const levels = plantLevels(pond, null), { full, entry, lighter } = kind([[10, 4, 0]], mirrored)
    levels.add(full, entry, lighter)
    levels.update(c, 900)
    assert.equal(full.count, mirrored ? 1 : 0)
    assert.equal(full.visible, mirrored)
  }
})

test('nothing in view goes missing before the next re-sort, which comes once the camera has moved or turned that far', () => {
  let seed = 7
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  const places = Array.from({ length: 600 }, () => [random() * 60 - 30, random() * 8, random() * 60 - 30])
  const pond = { meta: { ...world.meta, water_level: 0 } }, levels = plantLevels(pond, null), { full, entry, lighter } = kind(places)
  levels.add(full, entry, lighter)
  const base = new THREE.PerspectiveCamera(FOV, 16 / 9)
  base.position.set(0, 1.5, 0); base.lookAt(10, -.5, 4); base.updateMatrixWorld()
  levels.update(base, 900)
  const kept = tags(full)
  // Seen now: in the view, or in the view reflected in the water.
  const seenBy = c => { const view = exactView(c); return places.flatMap((p, i) => view.intersectsSphere(sphereOf(p)) || view.intersectsSphere(sphereOf([p[0], -p[1] - .01, p[2]])) ? [i] : []) }
  const axis = new THREE.Vector3(), turn = new THREE.Quaternion(), STEP = .25, TURN = 2.5 * Math.PI / 180
  const direction = () => { const u = random() * 2 - 1, a = random() * 2 * Math.PI, s = Math.sqrt(1 - u * u); return axis.set(s * Math.cos(a), u, s * Math.sin(a)) }
  for (let trial = 0; trial < 200; trial++) {
    const c = base.clone()
    c.position.add(direction().multiplyScalar(STEP * .99 * random()))
    c.quaternion.multiply(turn.setFromAxisAngle(direction(), TURN * .99 * random())); c.updateMatrixWorld()
    levels.update(c, 900)
    assert.deepEqual(tags(full), kept)                                     // no re-sort ...
    const shown = new Set(kept)
    assert.ok(seenBy(c).every(i => shown.has(i)), `trial ${trial}`)       // ... and nothing seen is missing
  }
  // Turned past TURN where it stands: a new list, for the new view.
  const turned = base.clone(); turned.quaternion.multiply(turn.setFromAxisAngle(new THREE.Vector3(0, 1, 0), .6)); turned.updateMatrixWorld()
  levels.update(turned, 900)
  assert.notDeepEqual(tags(full), kept)
  const shown = new Set(tags(full))
  assert.ok(seenBy(turned).every(i => shown.has(i)))
  assert.ok(shown.size < places.length / 2)
})

test('behind the loading screen a kind with nothing in view still draws one copy', () => {
  const levels = plantLevels(world, null), { full, entry, lighter } = kind([[-10, 0, 0], [0, 0, -10]])
  levels.add(full, entry, lighter)
  try {
    warmup.active = true
    levels.update(camera(), 900)
    assert.deepEqual([full.count, full.visible], [1, true])
    warmup.active = false
    levels.update(camera(), 900)
    assert.deepEqual([full.count, full.visible], [0, false])
  } finally { warmup.active = false }
})

// A spray: its full mesh in three parts (flowers with a value per copy, flower centres, stems) and one lighter level
// that keeps the flowers (as cards) and adds a leaf part, but has no centres and no stems (scene.json `parts`).
function spray(distances) {
  const tri = () => new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, .1, 0, 0, 0, .1, 0], 3))
  const part = (name, geometry = tri()) => new THREE.Mesh(geometry, Object.assign(new THREE.MeshBasicMaterial(), { name }))
  const instances = distances.map(d => ({ matrix: new THREE.Matrix4().makeTranslation(d, 0, 0).toArray() }))
  const level = new THREE.Group(); level.name = 'spray_lod1'
  level.add(part('Leaf'), part('Flower'))
  level.updateMatrixWorld()
  const lod = [{ name: 'spray_lod1', beyond: 9, parts: ['Flower', 'Leaf'] }]
  const parts = ['Flower', 'Centre', 'Stem'].map(name => {
    const source = part(name), full = new THREE.InstancedMesh(source.geometry, source.material, instances.length)
    instances.forEach((instance, i) => { full.setMatrixAt(i, new THREE.Matrix4().fromArray(instance.matrix)); full.setColorAt(i, new THREE.Color()) })
    const lighter = levelParts(lod, n => n === level.name ? level : null, source)
    if (name === 'Flower') for (const geometry of [source.geometry, ...lighter.filter(Boolean).map(o => o.geometry)])
      geometry.setAttribute('tag', new THREE.InstancedBufferAttribute(Float32Array.from(instances, (_, i) => i), 1))
    return { full, lighter, source }
  })
  return { entry: { instances, lod }, parts, level }
}

test('a plant of several materials: each part takes the level part of its own material, one level for all parts of a copy', () => {
  const { entry, parts: [flower, centre, stem], level } = spray([5, 15])
  assert.equal(flower.lighter[0], level.children[1])                       // paired by material, not by order
  assert.deepEqual(centre.lighter, [null])                                   // the level has no centres
  assert.deepEqual(stem.lighter, [stem.source])                              // nor stems: they stay whole
  // a level of a plant with one material is its one mesh, whatever its material is called
  assert.equal(levelParts([{ name: 'spray_lod1', beyond: 9 }], () => level, centre.full)[0], level.children[0])
  assert.throws(() => levelParts([{ name: 'gone', beyond: 9 }], () => undefined, centre.full))
  const levels = plantLevels(world, null)
  assert.equal(levels.add(flower.full, entry, flower.lighter).length, 1)
  assert.deepEqual(levels.add(centre.full, entry, centre.lighter), [])        // nothing to add for the centres' level
  assert.equal(levels.add(stem.full, entry, stem.lighter)[0].geometry, stem.full.geometry)
  const [flowers, centres, stems] = levels.sets
  for (const x of [0, -4, -.8, -4, 6, -.5]) {                               // back and forth across the 9 m (+-6%)
    levels.update(camera(x), 900)
    assert.deepEqual([...centres.level], [...flowers.level], `camera at ${x}`)
    assert.deepEqual([...stems.level], [...flowers.level], `camera at ${x}`)
  }
  levels.update(camera(-1), 900)                                             // copies 6 and 16 m away
  assert.deepEqual([...flowers.level], [0, 1])
  assert.deepEqual([flowers.meshes[0].count, flowers.meshes[1].count], [1, 1])
  assert.deepEqual(tags(flowers.meshes[1]), [1])                             // the far copy's value per copy came along
  assert.deepEqual([centres.meshes.length, centres.meshes[1], centres.meshes[0].count], [2, null, 1])   // its centres: none
  assert.deepEqual([stems.meshes[0].count, stems.meshes[1].count], [1, 1])  // its stems: whole
})
