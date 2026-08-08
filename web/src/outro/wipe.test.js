import test from 'node:test'
import assert from 'node:assert/strict'
import { WIPE, edgeTop, filled, selector, springStep } from './wipe.js'
import { REST, outro, restPoint, stepPage, trackPlace } from './timeline.js'
import { scroll, setScroll } from '../world/scroll.js'

const run = (state, goal, steps) => { for (let i = 0; i < steps; i++) springStep(state, goal); return state }

test('at rest the edge stops on its goal and is one pixel sharp', () => {
  const s = run({ v: 0, V: 0, B: 0 }, .5, 600)
  assert.deepEqual(s, { v: .5, V: .5, B: 0 })
  const H = 900, at = y => selector(.5, y, s.V, s.B, H, 16 / 9)
  assert.equal(at(.5 - 1 / H), 1)                          // a pixel below the edge: all light
  assert.equal(at(.5 + .01 / H), 0)                        // just above it: none
  assert.equal(selector(.1, .5 - 1 / H, s.V, s.B, H, 16 / 9), 1)   // no bend at rest
})

test('a step lags behind and never overshoots', () => {
  const s = { v: 0, V: 0, B: 0 }
  run(s, 1, 4)
  assert.ok(s.V < s.v && s.v < 1 && s.B > 0)
  for (let i = 0; i < 600; i++) { springStep(s, 1); assert.ok(s.V <= 1) }
  assert.equal(s.V, 1)
})

test('a fast scroll (1650 px/s) bows ~27 px and softens ~6 px as in alche\'s film, trailing by follower + spring', () => {
  const u = 1650 / 900 * WIPE.step
  let goal = .5 - 240 * u                                  // ends at .5, the edge mid-window
  const s = { v: goal, V: goal, B: 0 }
  for (let i = 0; i < 240; i++) { goal += u; springStep(s, goal) }
  const lag = (goal - s.V) * 900, bow = s.B * 900, soft = (1 / 900 + s.B * .2) * 900
  assert.ok(lag > 100 && lag < 120, `lag ${lag}`)
  assert.ok(bow > 22 && bow < 30, `bow ${bow}`)
  assert.ok(soft > 5 && soft < 8, `soft ${soft}`)
  // the middle of the edge sits lower than its ends, by the bow
  const y = q => { let lo = 0, hi = 1; for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (selector(q, m, s.V, s.B, 900, 16 / 9) > .5) lo = m; else hi = m } return lo }
  assert.ok(Math.abs((y(0) - y(.5)) * 900 - bow) < 1)
})

test('the light is not drawn up to .01, fills the window once its edge passes the top, and its quad reaches the edge', () => {
  assert.equal(selector(.5, 0, WIPE.shown, 0, 900, 1), 0)
  assert.equal(filled(.995, .003, 900, 16 / 9), false)     // past .99 (covered) with the middle still below the top
  assert.equal(filled(1, 0, 900, 16 / 9), true)
  assert.equal(edgeTop(WIPE.covered, 0, 900, 1), 1)
  for (const B of [-.03, 0, .03]) {
    const top = edgeTop(.4, B, 900, 16 / 9)
    for (let x = 0; x <= 1; x += .125) assert.equal(selector(x, top, .4, B, 900, 16 / 9), 0)
  }
})

test('the scroll track: the path, then viewports into the outro', () => {
  assert.deepEqual(trackPlace(450, 900, 100), { progress: .5, after: 0 })
  assert.deepEqual(trackPlace(900, 900, 100), { progress: 1, after: 0 })
  assert.deepEqual(trackPlace(1150, 900, 100), { progress: 1, after: 2.5 })
})

test('the snap goes to the nearest of alche\'s rests anywhere past the path\'s end, and lets the path be', () => {
  assert.equal(restPoint(0), null)
  assert.equal(restPoint(.1), REST[0])
  assert.equal(restPoint(1), REST[0])
  assert.equal(restPoint(1.3), REST[1])
  assert.equal(restPoint(2.5), REST[2])
  assert.equal(restPoint(3.1), REST[2])
  assert.ok(Math.abs(REST[0] - .5933) < 1e-4 && Math.abs(REST[1] - 1.7789) < 1e-4 && Math.abs(REST[2] - 2.9656) < 1e-4)
})

test('the camera and the outro ease as one place: the outro moves only on the path\'s end, the camera only at its start', () => {
  Object.assign(outro, { ratio: .1, target: 2, eased: 0 })
  setScroll(.5, true); setScroll(1)                         // End from the middle of the path
  let frames = 0, landed = -1
  for (; frames < 600 && (scroll.eased !== 1 || outro.eased !== 2); frames++) {
    stepPage(1 / 60)
    assert.ok(outro.eased === 0 || scroll.eased === 1)
    if (landed < 0 && scroll.eased === 1) landed = outro.eased
  }
  assert.ok(frames < 600 && landed > 0, `the boundary is crossed at speed, not stopped at (${landed})`)
  outro.target = 0; setScroll(.5)                           // and back
  for (let i = 0; i < 600; i++) { stepPage(1 / 60); assert.ok(scroll.eased === 1 || outro.eased === 0) }
  assert.equal(scroll.eased, .5); assert.equal(outro.eased, 0); assert.equal(scroll.moving, false)
  Object.assign(outro, { ratio: 0, target: 0, eased: 0 })
})
