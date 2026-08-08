import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createReveal, lineAmount, markerAmount } from './content.js'

const near = (a, b, tolerance = .002) => assert.ok(Math.abs(a - b) < tolerance, `${a} is not ${b}`)

test('lines and bars match alche at the lines\' clock read from their page', () => {
  near(lineAmount(.0376, 0, 3), .848)                  // y 7800: first line's opacity, first bar 4.48%
  near(markerAmount(.0376, 0, 3), .0448)
  near(markerAmount(.348, 0, 3), .952)                 // y 8200
  near(markerAmount(.348, 1, 3), .278)
  near(markerAmount(.725, 1, 3), .997)                 // y 8300
  near(markerAmount(.725, 2, 3), .691)
  assert.equal(lineAmount(0, 1, 3), 0)
  assert.equal(markerAmount(1, 0, 3), 1)
  near(markerAmount(1, 2, 3), .998)                    // as alche's: the last bar stops a hair short of its line's end
})

test('the reveal starts where it is, runs on past half way by itself, and comes to rest', () => {
  const step = createReveal()
  assert.deepEqual(step(0, 0), { mask: 0, u: 0, still: true })
  let frame = step(.6, 1 / 60)
  assert.equal(frame.mask, 0)                          // a frame behind, as alche's followers
  for (let i = 0; i < 600 && !frame.still; i++) frame = step(.6, 1 / 60)
  assert.ok(frame.still)
  near(frame.mask, .6, 1e-9)
  near(frame.u, 1 - .4 * .7, 1e-9)                    // past half way the lines' clock is pulled toward the end
  for (let i = 0; i < 600; i++) frame = step(0, 1 / 60)
  assert.deepEqual(frame, { mask: 0, u: 0, still: true })
})
