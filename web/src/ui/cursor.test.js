import test from 'node:test'
import assert from 'node:assert/strict'
import { CURSOR, followStep, stretch } from './cursor.js'

const near = (a, b, tolerance, label) => assert.ok(Math.abs(a - b) <= tolerance, `${label}: ${a} vs ${b}`)
// The ring chasing a still pointer for `seconds` at `hz`; also when (if) it first sat exactly on the pointer.
const chase = (to, seconds, hz, from = { x: 0, y: 0 }) => {
  const pos = { ...from }; let settled = null
  for (let i = 1; i <= Math.round(seconds * hz); i++) { followStep(pos, to, 1 / hz); if (settled === null && pos.x === to.x && pos.y === to.y) settled = i / hz }
  return { pos, settled }
}

test('their step: at 60 Hz the ring closes 20% of the gap, rounded to whole pixels first', () => {
  const pos = followStep({ x: 0, y: 0 }, { x: 100.4, y: -50.6 }, 1 / 60)          // gaps round to 100 and -51
  near(pos.x, 20, 1e-12, 'x'); near(pos.y, -10.2, 1e-12, 'y')
  const from = followStep({ x: 10.3, y: 7 }, { x: 20, y: 7 }, 1 / 60)              // a gap of 9.7 rounds to 10
  near(from.x, 12.3, 1e-12, 'from a fractional place'); assert.equal(from.y, 7)
  assert.equal(CURSOR.follow, .2)
})

test('by time, not frames: 60 and 144 Hz agree over whole-frame spans (0.25 s and 0.5 s)', () => {
  const to = { x: 1000, y: 370 }
  for (const seconds of [.25, .5]) {
    const a = chase(to, seconds, 60).pos, b = chase(to, seconds, 144).pos
    near(a.x, b.x, .5, `x at ${seconds} s`); near(a.y, b.y, .5, `y at ${seconds} s`)
  }
  near(chase(to, .25, 60).pos.x, 965, .5, 'at 0.25 s, 96.5% of the way (1 - 0.8^15, the rounding aside)')
})

test('it stops exactly: on the pointer within 0.65 s of a long move, at any rate, then never moves', () => {
  for (const hz of [60, 144, 240]) for (const to of [{ x: 1, y: 0 }, { x: 2000, y: -740 }, { x: 300.25, y: 12.5 }]) {
    const { pos, settled } = chase(to, 2, hz)
    assert.ok(settled !== null && settled < .65, `${hz} Hz to ${JSON.stringify(to)}: settled at ${settled}`)
    assert.deepEqual(followStep({ ...pos }, to, 1 / hz), to, 'and stays')
  }
  // Within half a pixel the rounded gap is nothing: the ring is put on the pointer instead of creeping toward it.
  assert.deepEqual(followStep({ x: 99.6, y: 50.4 }, { x: 100, y: 50 }, 1 / 60), { x: 100, y: 50 })
})

test('the stretch: nothing at rest, gap / 200, at most 0.55 (110 px), along the motion', () => {
  assert.equal(stretch(0, 0).s, 0)
  near(stretch(60, 80).s, .5, 1e-12, '100 px'); near(stretch(20, 0).s, .1, 1e-12, '20 px')
  assert.equal(stretch(110, 0).s, .55); assert.equal(stretch(0, -300).s, .55); assert.equal(stretch(3000, 4000).s, CURSOR.cap)
  assert.equal(stretch(10, 0).angle, 0); assert.equal(stretch(0, 10).angle, 90); assert.equal(stretch(-10, 0).angle, 180)
  near(stretch(10, -10).angle, -45, 1e-12, 'up and to the right (screen y points down)')
})
