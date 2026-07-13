import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three/webgpu'
import { SCROLL, home, scroll, scrollAhead, scrollPace, setFlightPath, setScroll, stepScroll } from './scroll.js'

// a circle of 2400 frames at an even pace, as the real path's middle (progress 1 is the pose of progress 0)
const path = {
  frames: 2400,
  poseAt(progress, position, quaternion) {
    const a = Math.min(1, Math.max(0, progress)) * Math.PI * 2
    position.set(6 * Math.sin(a), 1, 6 * Math.cos(a)); quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), a)
  },
}
setFlightPath(path)
const run = (seconds, frame = 1 / 60) => { for (let i = Math.round(seconds / frame); i > 0; i--) stepScroll(frame); return scroll.eased }
const near = (a, b, tolerance, label) => assert.ok(Math.abs(a - b) <= tolerance, `${label}: ${a} vs ${b}`)

test('the camera follows the scroll at its pace: 10% a 60 Hz frame, 90% of the way in under half a second', () => {
  setScroll(.2, true); setScroll(.5)
  assert.equal(scroll.moving, true)
  near(run(1 / 60), .2 + .3 * SCROLL.ease, 1e-12, 'one frame')
  near(run(.35), .2 + .3 * (1 - (1 - SCROLL.ease) ** 22), 1e-9, '22 frames')
  assert.ok(scroll.eased > .2 + .3 * .9)
  run(2); assert.equal(scroll.eased, .5); assert.equal(scroll.moving, false)
})

test('back and forth anywhere: no stops, the scroll can turn round mid-way', () => {
  setScroll(0, true); setScroll(.6); run(.1)
  const mid = scroll.eased; setScroll(.1); run(.05)
  assert.ok(scroll.eased < mid, 'turned back at once'); run(3); assert.equal(scroll.eased, .1)
})

test('time, not frames: 60 Hz and 144 Hz agree', () => {
  setScroll(0, true); setScroll(1); const at60 = run(.25, 1 / 60)
  setScroll(0, true); setScroll(1); const at144 = run(.25, 1 / 144)
  near(at60, at144, 1e-9, '0.25 s')
})

test('back to start flies the shorter way round and lands on 0; any scroll ends the flight', () => {
  let landed = null; scroll.landed = to => { landed = to }
  setScroll(.75, true); home(); assert.equal(scroll.target, 1, 'on round through the end')
  near(scroll.flight.duration, 4.5, 1e-9, 'a quarter of the path: 3 s + 1.5 s')
  run(4.6); assert.deepEqual([scroll.eased, scroll.target, scroll.moving, landed], [0, 0, false, 0])
  setScroll(.3, true); home(); assert.equal(scroll.target, 0, 'back'); run(1)
  setScroll(.4); assert.equal(scroll.flight, null); run(3); assert.equal(scroll.eased, .4)
  scroll.landed = null
})

test('snap puts the camera there at once; the pace and the place ahead are known', () => {
  setScroll(.4, true); assert.deepEqual([scroll.target, scroll.eased, scroll.moving], [.4, .4, false])
  assert.equal(scrollPace(1 / 60), 0)
  setScroll(.6); const ahead = scrollAhead(.25), pace = scrollPace(1 / 60)
  assert.ok(pace > 0); run(.25); near(scroll.eased, ahead, 1e-9, 'a quarter second on')
  setScroll(1.5, true); assert.equal(scroll.eased, 1); setScroll(-1, true); assert.equal(scroll.eased, 0)
})
