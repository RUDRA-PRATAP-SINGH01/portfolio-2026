import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three/webgpu'
import { widenedView } from '../world/viewChange.js'
import { SLACK_SCALE, layersOf, slackScale, slackUsed, startList, stepList, turnOf, writeList } from './grassList.js'

const SLACK = { distance: .4, angle: 2.5 * Math.PI / 180 }

// A field of tufts in two batches (as GrassSystem sorts them by kind), with seeded random places, scales and hashes.
function field(seed = 7) {
  let s = seed; const random = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296
  const n = 3000, roots = new Float32Array(n * 4), scales = new Float32Array(n * 4)
  for (let i = 0; i < n; i++) { roots.set([random() * 60 - 30, random() * 2, random() * 60 - 30, random() * 6], i * 4); scales[i * 4] = .6 + random() * .8 }
  const batch = (first, count, K, nominalHeight) => ({ first, count, K, nominalHeight, keepHashes: Float32Array.from({ length: count * K }, random) })
  return { roots, scales, batches: [batch(0, 1900, 24, .25), batch(1900, 1100, 48, .14)] }
}
// Fresh scratch runs for each build, so two builds never share them.
const withRuns = batches => batches.map(b => ({ ...b, runs: [0, 1, 2].map(() => new Float32Array(b.count * b.K)) }))

function view(eye, look, { foliage = 1, legacy = false } = {}) {
  const camera = new THREE.PerspectiveCamera(40, 16 / 9, .05, 400)
  camera.position.set(...eye); camera.lookAt(...look); camera.updateMatrixWorld()
  const matrix = new THREE.Matrix4(), { sx, sy } = widenedView(camera, SLACK.angle, matrix)
  return { matrix: matrix.elements.slice(), eye: { x: eye[0], y: eye[1], z: eye[2] }, sx, sy, slack: SLACK.distance, pixel: 2 * Math.tan(20 * Math.PI / 180) / 900,
    lodFar: 30, lodNear: 6, lodMin: .08, bladeKeep: .9, legacy, drawK: [24, 48].map(K => Math.max(4, Math.round(K * foliage))) }
}
const views = [view([0, 1.6, 20], [0, 0, 0]), view([5, 3, -4], [-10, 0, 10], { foliage: .55 }), view([-12, .8, 0], [20, 1, 3], { legacy: true }), view([0, 25, 0], [0, 0, 1])]

// The list a build leaves: per batch, the runs' filled parts.
const listOf = (build, batches) => batches.map((b, k) => b.runs.map((run, level) => Array.from(run.subarray(0, build.counts[k][level]))))
function oneShot(v, data) {
  const batches = withRuns(data.batches), build = startList(v, batches)
  assert.equal(stepList(build, batches, data.roots, data.scales), true)
  return listOf(build, batches)
}

test('a list built in slices equals the one-shot list, element for element', () => {
  const data = field()
  for (const v of views) {
    const whole = oneShot(v, data)
    assert.ok(whole.flat(2).length > 100, 'the view sees grass')
    for (const size of [1, 7, 512, 1899, 1900, 2999]) {
      const batches = withRuns(data.batches), build = startList(v, batches)
      let slices = 0
      while (!stepList(build, batches, data.roots, data.scales, size)) slices++
      assert.equal(slices, Math.ceil(3000 / size) - 1, `slices of ${size}`)
      assert.deepEqual(listOf(build, batches), whole, `slices of ${size}`)
    }
  }
  // The views between them use all three blade shapes.
  for (let level = 0; level < 3; level++) assert.ok(views.some(v => oneShot(v, data).some(runs => runs[level].length)), `level ${level} used`)
})

test('the cursor resumes where it stopped, across the batch boundary', () => {
  const data = field(3), batches = withRuns(data.batches), build = startList(views[0], batches)
  stepList(build, batches, data.roots, data.scales, 1850)
  assert.deepEqual([build.batch, build.tuft, build.done], [0, 1850, false])
  stepList(build, batches, data.roots, data.scales, 100)
  assert.deepEqual([build.batch, build.tuft, build.done], [1, 1950, false])
  assert.equal(stepList(build, batches, data.roots, data.scales, 0), false)
  assert.equal(stepList(build, batches, data.roots, data.scales, 1050), true)
  assert.deepEqual(listOf(build, batches), oneShot(views[0], data))
})

test('the fallback: a build abandoned half way leaves no trace in the one-shot build that replaces it', () => {
  const data = field(5), batches = withRuns(data.batches)
  const abandoned = startList(views[1], batches)
  stepList(abandoned, batches, data.roots, data.scales, 2400)
  const build = startList(views[0], batches)                       // the same scratch runs, as in GrassSystem
  stepList(build, batches, data.roots, data.scales)
  assert.deepEqual(listOf(build, batches), oneShot(views[0], data))
})

test('writeList lays the runs out near | mid | far and reports the span that changed, if any', () => {
  const ids = new Float32Array(8), offsets = [0, 0, 0], runs = [[1, 2], [], [3, 4, 5]].map(r => Float32Array.from(r))
  assert.deepEqual(writeList(ids, runs, [2, 0, 3], offsets), [0, 5])
  assert.deepEqual([Array.from(ids.subarray(0, 5)), offsets], [[1, 2, 3, 4, 5], [0, 2, 2]])
  assert.equal(writeList(ids, runs, [2, 0, 3], offsets), null)
  assert.deepEqual(writeList(ids, runs, [1, 0, 3], offsets), [1, 4])        // 1 3 4 5: places 1 to 3 changed
})

test('layersOf: the index texture layers a changed span touches', () => {
  assert.deepEqual([...layersOf([0, 1], 4096)], [0])
  assert.deepEqual([...layersOf([4095, 4097], 4096)], [0, 1])
  assert.deepEqual([...layersOf([8192, 12289], 4096)], [2, 3])
})

test('slackUsed: the larger of the distance and the turn, as a share of the slack', () => {
  const pose = (x, yaw = 0) => ({ position: new THREE.Vector3(x, 0, 0), quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw) })
  assert.equal(slackUsed(pose(0), pose(0), SLACK), 0)
  assert.ok(Math.abs(slackUsed(pose(0), pose(.2), SLACK) - .5) < 1e-12)
  assert.ok(Math.abs(slackUsed(pose(0), pose(.1, SLACK.angle * .8), SLACK) - .8) < 1e-6)
  assert.ok(slackUsed(pose(0), pose(.41), SLACK) > 1)
  assert.equal(slackUsed({ position: new THREE.Vector3(Infinity, 0, 0), quaternion: new THREE.Quaternion() }, pose(0), SLACK), Infinity)   // no list yet
})

test('slackScale: a flight\'s fastest frames over one build, against 1 + reach slacks, a fifth to spare, 1 to 3.5', () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} vs ${b}`)
  assert.equal(slackScale(0, 4, .9), 1)                                 // at rest
  assert.equal(slackScale(.2, 4, .9), 1)                                // slow enough for the resting slack
  near(slackScale(1, 3, .9), 3 / 1.9 * 1.2); near(slackScale(1, 3, .5), 3 / 1.5 * 1.2)
  // the longest leg (56.3 units in 3 s, flight.js: four times the average at the peak) at 60 Hz, a build of 3 frames
  near(slackScale(4 * 56.3 / 3 / 60, 3, .9), 4 * 56.3 / 3 / 60 * 3 / 1.9 * 1.2)
  assert.ok(slackScale(4 * 56.3 / 3 / 60, 3, .9) < 2.5)
  assert.equal(slackScale(10, 4, .9), SLACK_SCALE.most)
  // A list of that slack, built `reach` ahead of where the camera is when it is finished, holds for one more build
  // at the fastest: the camera crosses (1 + reach) x scale x spare-free units in those frames.
  const peak = 1.1, frames = 4, scale = slackScale(peak, frames, .9)
  assert.ok(peak * frames <= (1 + .9) * scale)
})

test('turnOf: the angle of the turn parallax.js makes from a pitch then a yaw', () => {
  for (const [a, b] of [[0, 0], [.0077, .0077], [-.0077, .003], [.135, -.035], [.4, .2]]) {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(a, b, 0, 'XYZ'))
    assert.ok(Math.abs(turnOf(Math.abs(a), Math.abs(b)) - 2 * Math.acos(Math.min(1, Math.abs(q.w)))) < 1e-12, `${a}, ${b}`)
    assert.ok(Math.abs(turnOf(a, b) - turnOf(Math.abs(a), Math.abs(b))) < 1e-15)
  }
  assert.ok(Math.abs(turnOf(.0077, .0077) - Math.SQRT2 * .0077) < 1e-7, 'about sqrt(2) x each, for small turns')
})
