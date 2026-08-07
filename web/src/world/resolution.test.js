import test from 'node:test'
import assert from 'node:assert/strict'
import { RESOLUTION, TRIAL, bounds, decide, fitScale, levelRatio, lowScale, nextLevel, startLevel } from './resolution.js'

test('one dot per point and hatom\'s cap, never more than the screen has', () => {
  assert.deepEqual(bounds(1), { floor: 1, cap: 1 })
  assert.deepEqual(bounds(1.25), { floor: 1, cap: 1.25 })
  assert.deepEqual(bounds(2), { floor: 1, cap: 1.4 })
  assert.deepEqual(bounds(3), { floor: 1, cap: 1.4 })
  assert.deepEqual(bounds(.8), { floor: .8, cap: .8 })                   // zoomed out: the screen's own ratio
})

test('the cap stays when the moving-pointer frames fit the budget', () => {
  assert.equal(decide({ capMs: 5.7 }), 'cap')                             // the RTX at 1.4
  assert.equal(decide({ capMs: RESOLUTION.budgetMs }), 'cap')
})

test('too slow at the cap: the floor is timed, and taken only if it is clearly faster', () => {
  assert.equal(decide({ capMs: 24.7 }), 'measure-floor')
  assert.equal(decide({ capMs: 24.7, floorMs: 16 }), 'floor')              // the Intel laptop: pixels were the limit
  assert.equal(decide({ capMs: 33.3, floorMs: 33 }), 'cap')                // the processor was: keep the sharpness
  assert.equal(decide({ capMs: 20, floorMs: 20 * RESOLUTION.pixelGain }), 'floor')
})

test('a screen with no more than the floor: the floor is timed, and a lower ratio only when it is far too slow', () => {
  assert.equal(decide({}), 'measure-floor')
  assert.equal(decide({ floorMs: 16 }), 'floor')                           // the Intel laptop keeps one dot per point
  assert.equal(decide({ floorMs: RESOLUTION.lowMs }), 'floor')
  assert.equal(decide({ floorMs: 45 }), 'measure-low')                     // 20 fps: the reported laptop
  assert.equal(decide({ capMs: 60, floorMs: 45 }), 'measure-low')
})

test('the lower ratio: what fits the budget by the two timings, and nothing given away when pixels are not the limit', () => {
  assert.equal(lowScale(45), .58); assert.equal(lowScale(200), RESOLUTION.min); assert.equal(lowScale(15), 1)
  assert.equal(fitScale({ floorMs: 45, lowMs: 20, scale: .58 }), .5)       // still slow: lower, held at the minimum
  assert.equal(fitScale({ floorMs: 24, lowMs: 15, scale: .79 }), .79)      // the share tried fits
  assert.equal(fitScale({ floorMs: 30, lowMs: 29, scale: .7 }), null)      // nothing gained: no pixels given away
  assert.equal(fitScale({ floorMs: 30, lowMs: 12, scale: .71 }), .79)      // faster than needed: some sharpness back
  assert.deepEqual([null, 16, 22, 31, 50].map(startLevel), [0, 0, 2, 3, 4])
})

test('the ratio drawn: the choice, lowered by the controller, never under half the floor', () => {
  const b = bounds(2)
  assert.equal(levelRatio(b, 'cap'), 1.4)
  assert.ok(Math.abs(levelRatio(b, 'cap', .85) - 1.19) < 1e-9)
  assert.ok(Math.abs(levelRatio(b, 'cap', .55) - .77) < 1e-9)
  assert.equal(levelRatio(b, 'floor', .55), .55)
  assert.equal(levelRatio(b, 'floor', .3), .5)
  assert.equal(levelRatio(b, null), 1)                                     // undecided: the floor
  assert.equal(levelRatio(b, 'low', 1, .6), .6)                            // the test's share
  assert.equal(levelRatio(b, 'low', .85, .6), .6)                          // a level's factor does not multiply it
  assert.equal(levelRatio(b, 'low', .55, .6), .55)
  assert.ok(Math.abs(levelRatio(bounds(.8), 'cap', .55) - .44) < 1e-9)
})

// The running controller over a visit: one window every 5 s; `frame(level, window)` gives that window's frame time.
function visit(frame, { minutes = 10, level = 0, minLevel = 0 } = {}) {
  let memo = {}; const steps = []
  for (let i = 0, now = 0; now < minutes * 60000; i++, now += 5000) {
    const ms = frame(level, i), d = nextLevel({ level, minLevel, p90: ms, mean: ms, now, memo })
    if (d.level !== level) steps.push({ at: now / 1000, from: level, to: d.level })
    level = d.level; memo = d.memo
  }
  return { level, steps }
}

test('a screen held at 30 fps: one trial, undone, and never again while frames stay the same', () => {
  const { level, steps } = visit(() => 33.3)
  assert.equal(level, 0)
  assert.deepEqual(steps.map(s => [s.from, s.to]), [[0, 1], [1, 0]])
})

test('a chip limited by pixels steps down until frames fit, and keeps the steps that helped', () => {
  const { level, steps } = visit(level => [30, 24, 18, 15][level])
  assert.equal(level, 2)
  assert.deepEqual(steps.map(s => [s.from, s.to]), [[0, 1], [1, 2]])
})

test('failed trials wait longer each time (30 s, 60 s, 120 s ...) when frames change between them', () => {
  // Frames slower every minute (heat), but a step never helps: each failure is followed by a longer wait.
  const { steps } = visit((_, i) => 30 * (1 + .15 * Math.floor(i / 12)), { minutes: 8 })
  const tries = steps.filter(s => s.to > s.from).map(s => s.at), gaps = tries.slice(1).map((t, i) => t - tries[i])
  assert.ok(gaps.length >= 2 && gaps.every((gap, i) => i === 0 || gap > gaps[i - 1]), JSON.stringify(tries))
  assert.ok(tries.every((t, i) => i === 0 || t - tries[i - 1] >= TRIAL.wait / 1000))
})

test('fast frames step back up, never above the lightest level allowed for the visit', () => {
  assert.equal(visit(() => 10, { level: 3 }).level, 0)
  assert.equal(visit(() => 10, { level: 3, minLevel: 2 }).level, 2)
})
