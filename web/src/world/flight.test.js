import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three/webgpu'
import { FLIGHT, createFlight, flightDuration, measureView, power4InOut } from './flight.js'

const near = (a, b, tolerance, label) => assert.ok(Math.abs(a - b) <= tolerance, `${label}: ${a} vs ${b}`)

// a test path: 10 m straight along x over frames 0-100, then a 90 degree turn on the spot over frames 100-200
const path = {
  frames: 200,
  poseAt(progress, position, quaternion) {
    const f = Math.min(1, Math.max(0, progress)) * 200
    position.set(Math.min(f, 100) / 10, 0, 0)
    quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.max(0, f - 100) / 100 * Math.PI / 2)
  },
}

test('their curve: power4.inOut, 87% of the way in the middle 1.2 s of 3', () => {
  assert.equal(power4InOut(0), 0); assert.equal(power4InOut(1), 1); assert.equal(power4InOut(.5), .5)
  near(power4InOut(.2), .0128, 1e-12, 'first 0.6 s'); near(power4InOut(.7) - power4InOut(.3), .8704, 1e-12, 'middle 1.2 s')
  near(power4InOut(.3) + power4InOut(.7), 1, 1e-12, 'symmetric')
  const h = 1e-6; near((power4InOut(.5 + h) - power4InOut(.5 - h)) / (2 * h), 4, 1e-4, 'peak speed, times the average')   // (finite difference)
  assert.equal(FLIGHT.duration, 3)
})

test('the path is measured by how much the view changes: metres / 0.4 or degrees / 2.5, whichever is more', () => {
  const m = measureView(path)
  near(m.at(.5), 10 / .4, 1e-9, 'the straight part'); near(m.total, 10 / .4 + 90 / 2.5, 1e-6, 'and the turn')
  for (const p of [0, .1, .37, .5, .77, 1]) near(m.progressAt(m.at(p)), p, 1e-12, `inverse at ${p}`)
  assert.equal(m.progressAt(-1), 0); assert.equal(m.progressAt(1e9), 1)
})

test('a flight follows their curve in view change, and lands exactly', () => {
  const m = measureView(path), f = createFlight(0, 1, m, 3)
  assert.equal(f.progressAt(0), 0); assert.equal(f.progressAt(3), 1); assert.equal(f.progressAt(5), 1)
  for (const s of [.3, .9, 1.5, 2.1, 2.7]) near(m.at(f.progressAt(s)), m.total * power4InOut(s / 3), 1e-6, `view change at ${s} s`)
  near(f.peakPerFrame(), 4 * m.total / 3 / 60, 1e-12, 'peak per 60 Hz frame')
  const back = createFlight(1, .5, m, 3)
  near(back.progressAt(1.5), m.progressAt((m.total + m.at(.5)) / 2), 1e-12, 'backwards too')
})

test('"Back to start" takes 3 s plus 3 s per half of the path flown: 3 to 6 s', () => {
  const m = measureView(path)
  assert.equal(flightDuration(0, 0, m), 3)
  // (home() flies the shorter way round the orbit, so at most half of it: 6 s)
  const half = m.progressAt(m.total / 2); near(flightDuration(half, 0, m), 6, 1e-9, 'half the path'); near(flightDuration(half, 1, m), 6, 1e-9, 'or on round')
  near(flightDuration(.25, 0, m), 3 + 6 * m.at(.25) / m.total, 1e-12, 'by the view change flown')
  near(flightDuration(.25, 0), 4.5, 1e-12, 'without a measure, by progress')
})
