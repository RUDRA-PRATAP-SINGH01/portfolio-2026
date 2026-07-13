import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three/webgpu'
import { PARALLAX, createParallax, fractal, steady, swingReach, turnAbout } from './parallax.js'

const run = (rig, seconds, distance = 12, frame = 1 / 60) => { for (let i = Math.round(seconds / frame); i > 0; i--) rig.step(frame, distance) }
const near = (a, b, tolerance, label) => assert.ok(Math.abs(a - b) <= tolerance, `${label}: ${a} vs ${b}`)
const camera = () => { const c = new THREE.PerspectiveCamera(); c.position.set(0, 1, 0); return c }   // looking down -z

test('their angles: the view turns toward the pointer, 0.135 rad sideways and 0.035 up and down', () => {
  const rig = createParallax()
  rig.point(1600, 0, 1600, 900)                      // top-right corner: pointer (1, 1)
  rig.step(0, 12, 1, true, false)
  near(rig.state.yaw, -PARALLAX.yaw, 1e-12, 'yaw (to the right)'); near(rig.state.pitch, PARALLAX.pitch, 1e-12, 'pitch (up)')
  assert.equal(rig.state.roll, -0)
  const c = camera(); rig.apply(c)
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(c.quaternion)
  assert.ok(forward.x > 0 && forward.y > 0, 'looks right and up')
})

test('it turns round a point 0.63 x the subject\'s distance ahead: 7.6 m at the opening view, which stays put', () => {
  near(PARALLAX.pivot * 12, 7.5758, 1e-3, 'the point at 12 m')
  const c = camera(), point = new THREE.Vector3(0, 1, -PARALLAX.pivot * 12)
  turnAbout(c.position, c.quaternion, PARALLAX.pivot * 12, .035, -.135, -.05)
  const there = new THREE.Vector3(0, 0, -PARALLAX.pivot * 12).applyQuaternion(c.quaternion).add(c.position)
  near(there.distanceTo(point), 0, 1e-9, 'the point stays where it was')
  near(c.position.x, -PARALLAX.pivot * 12 * Math.sin(.135), .02, 'the camera swings the other way, about a metre')
  const r = swingReach(12)
  assert.ok(r.side > 1 && r.side < 1.1 && r.up > .25 && r.up < .35, `reach ${JSON.stringify(r)}`)
})

test('pointer eased 7.5% a frame: 90% of the way in half a second, by time not frames', () => {
  const at60 = createParallax(), at144 = createParallax()
  for (const rig of [at60, at144]) rig.point(1600, 450, 1600, 900)
  run(at60, .5, 12, 1 / 60); run(at144, .5, 12, 1 / 144)                   // (whole frames at both rates)
  near(at60.eased.x, .9, .01, '0.5 s'); near(at60.eased.x, at144.eased.x, 1e-9, '60 vs 144 Hz')
})

test('it banks into a quick move and levels out', () => {
  const rig = createParallax()
  rig.point(1600, 450, 1600, 900); run(rig, .3)
  assert.ok(rig.state.roll < -.02, `banks while the trailing pointer lags (${rig.state.roll})`)
  run(rig, 6); assert.ok(Math.abs(rig.state.roll) < 1e-3, 'level again')
})

test('the drift: centred, within +-0.0077 rad, slow, repeatable, off without strength; steady leaves it out', () => {
  let min = 1, max = -1
  for (let x = 0; x < 2000; x += .37) { const v = fractal(x); min = Math.min(min, v); max = Math.max(max, v) }
  assert.ok(min >= -1 && max <= 1 && min < -.5 && max > .5, `${min} .. ${max}`)
  const rig = createParallax(); rig.step(1 / 60, 12)
  const [a, b] = rig.driftAt(12.5); assert.ok(Math.abs(a) <= PARALLAX.drift.turn && Math.abs(b) <= PARALLAX.drift.turn)
  assert.deepEqual(rig.driftAt(12.5), [a, b])
  rig.step(1 / 60, 12, 0); assert.deepEqual(rig.driftAt(12.5), [0, 0])
  rig.step(1 / 60, 12, 1, false, true); rig.state.time = 40
  const c = camera(); rig.apply(c)
  assert.ok(steady.valid && steady.quaternion.angleTo(c.quaternion) > 0, 'the drift turns the camera past steady')
  assert.ok(steady.quaternion.angleTo(c.quaternion) <= Math.SQRT2 * PARALLAX.drift.turn + 1e-9)
})

test('ahead: the swing a few frames on, the pointer held', () => {
  const rig = createParallax(); rig.point(1600, 450, 1600, 900); run(rig, .1)
  const predicted = rig.ahead(6); run(rig, .1)
  near(rig.state.yaw, predicted.yaw, 1e-9, 'yaw'); near(rig.state.roll, predicted.roll, 1e-9, 'roll')
})
