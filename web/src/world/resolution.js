// How sharp the scene is drawn: hatom.com's rule, decided by timing our own scene on the visitor's chip.
//
// hatom (read from their code, 2026-11-13) starts every visit at one rendered dot per screen point, looks the
// graphics chip up in detect-gpu's table, then allows min(devicePixelRatio, 1.4) on any chip above the weakest
// tiers, recomputed on every resize; the browser stretches the canvas over the screen. Their table rates the Intel
// UHD of our test laptop as fast, while our scene at 1.4 runs there at about 40 fps. So instead of the table we
// time our own scene, once, behind the loading screen (AdaptiveQuality.jsx runs the test):
//   floor = min(devicePixelRatio, 1)    one dot per point; every visit starts here
//   cap   = min(devicePixelRatio, 1.4)
// The scene is drawn at the cap with the load of a moving pointer (the pond's reflection every frame, the cursor
// liquid running). If the graphics chip finishes its frames in 15 ms or less on average, the cap stays. Otherwise
// the floor is timed too: unless it is at least 8% faster, pixels were not what held the frames back (the
// processor was), and the cap stays anyway: sharpness is never given away for nothing.
// What is timed is when the chip has FINISHED each frame (gpuFinished below), not the frame callbacks: behind the
// loading screen, for the first second or so, the processor queues frames faster than the chip draws them (Intel
// at 1.4: callbacks every 10.5 ms, frames finished every 25 ms). The budget leaves 1.7 ms for the browser's own
// compositing of the visible page (Intel at 1.4: 28.5 ms between visible frames, 24.3 ms between finished ones).
// Measured on the Intel laptop (2026-11-13, 1600 x 900, pointer moving): 16.0 ms at 1, 21.2 at 1.25, 24.7 at 1.4.
// GPU timestamps are not used: on that chip three's timer read 3.6 ms for a 13 ms frame.

// repeat: frames drawn per screen refresh during the test. A screen at 60 Hz asks for a frame every 16.7 ms, so a
// chip that needs 10 ms and one that needs 16 would both seem to take 16.7; drawn twice, the chip is never left
// waiting, and half the time between finished refreshes is the cost of one frame (down to 8.3 ms).
//
// Chips too slow for one dot per point (added 2026-11-13, after a Lenovo IdeaPad 320 ran the deployed site at
// 20 fps). The floor is now timed on every screen, also where it is all the screen has. If a frame there takes
// more than lowMs, the visit gets a lighter level of the running controller (startLevel; AdaptiveQuality.jsx),
// which it never goes back above, and a lower ratio is tried at that level (lowScale) and timed as well. If that
// is clearly faster, the visit is drawn at the ratio that timing says fits the budget (fitScale), never under
// `min` of the floor, with a sharpening step in the last pass (displayPipeline.js).
// lowMs is well over the budget on purpose: the Intel laptop this was tuned on times 15 to 16 ms at the floor
// (20 when hot) and keeps one dot per point.
// lagMs: during the test a frame is started only while the chip is less than this far behind (Post.jsx). The
// chip is never left waiting, and a slow one is not handed many seconds of frames to work off afterwards.
export const RESOLUTION = Object.freeze({ cap: 1.4, budgetMs: 15, pixelGain: .92, settleFrames: 6, measureSeconds: .6, minFrames: 12, plainFrames: 6, repeat: 2,
  lowMs: 21, min: .5, lagMs: 250 })

/** One dot per point (never more than the screen has) and hatom's cap. */
export const bounds = (dpr = 1) => ({ floor: Math.min(dpr, 1), cap: Math.min(dpr, RESOLUTION.cap) })

/** The test's verdict from the mean frame times measured at the cap (null where the screen has no more than the
 *  floor) and, when asked for, at the floor: 'cap', 'floor', 'measure-floor' (time the floor before deciding) or
 *  'measure-low' (the floor is too slow as well: time a lower ratio). */
export function decide({ capMs = null, floorMs = null }) {
  if (capMs !== null && capMs <= RESOLUTION.budgetMs) return 'cap'
  if (floorMs === null) return 'measure-floor'
  if (capMs !== null && floorMs > capMs * RESOLUTION.pixelGain) return 'cap'      // pixels were not the limit
  return floorMs <= RESOLUTION.lowMs ? 'floor' : 'measure-low'
}

const limited = scale => Math.round(Math.min(1, Math.max(RESOLUTION.min, scale)) * 100) / 100

/** The share of the floor to try when a frame at the floor takes floorMs: the one that would fit the budget if
 *  the whole frame were pixel work. */
export const lowScale = floorMs => limited(Math.sqrt(RESOLUTION.budgetMs / floorMs))

/** The share kept, from the timing at the share tried (at the visit's lighter level): the one that would fit the
 *  budget if the whole frame were pixel work. Part of a frame is not, so this corrects too little rather than too
 *  much, in both directions: sharpness handed back never breaks the budget, and what is still missing is left to
 *  the running controller. Null when the try was not clearly faster than the floor: then neither pixels nor the
 *  lighter level are what holds the frames back, and no pixels are given away. */
export function fitScale({ floorMs, lowMs, scale }) {
  if (lowMs > floorMs * RESOLUTION.pixelGain) return null
  return limited(scale * Math.sqrt(RESOLUTION.budgetMs / lowMs))
}

/** The running controller's lightest level for the visit (AdaptiveQuality.jsx: a smaller, rarer pond reflection,
 *  a shorter range of grass and near leaves, from 3 no cursor liquid): 0 unless a frame at the floor took more
 *  than lowMs. */
export const startLevel = (floorMs = null) => floorMs === null || floorMs <= RESOLUTION.lowMs ? 0 : floorMs > 45 ? 4 : floorMs > 30 ? 3 : 2

/** The ratio drawn: the visit's choice ('cap', 'floor', or 'low' with its share of the floor; the floor until the
 *  test is done), lowered by the running controller's factor for its level; never under `min` of the floor. */
export const levelRatio = ({ floor, cap }, kind, factor = 1, scale = 1) =>
  Math.max(floor * RESOLUTION.min, (kind === 'cap' ? cap : floor) * Math.min(factor, kind === 'low' ? scale : 1))

/** The running controller's decision after one window of frames (AdaptiveQuality.jsx: about 4 s; p90 and mean in
 *  ms). Slow windows step down a level (fewer pixels, a smaller and rarer pond reflection, fewer blades), fast
 *  ones step back up. Every step down is a trial: unless the next window's average frame is at least a twentieth
 *  shorter, the step bought nothing (a screen held at 30 fps by a battery saver, a busy processor), so it is undone
 *  and none is tried again until `hold`. The wait doubles with each failed trial (30 s up to 10 min) and does not
 *  end while frames stay within a tenth of the time that failed: such a device is not made to lose sharpness every
 *  half minute. (The average for the trial, not the 90th percentile: frame times bunch at multiples of the refresh
 *  interval, and the slow bunch keeps its place until the average has dropped a long way.)
 *  memo: what the controller remembers between windows; pass back what it returns. */
export function nextLevel({ level, minLevel = 0, top = 4, p90, mean, now, memo = {} }) {
  const m = { good: 0, wait: TRIAL.wait, hold: 0, trial: null, failed: null, ...memo }
  if (m.trial) {
    const { from, to, mean: before } = m.trial
    m.trial = null
    if (level === to && mean > before * .95) {
      Object.assign(m, { hold: now + m.wait, wait: Math.min(m.wait * 2, TRIAL.longest), failed: mean, good: 0 })
      return { level: from, memo: m }
    }
    if (level === to) m.wait = TRIAL.wait                                // it helped: the next wait starts short
  }
  let next = level
  if (p90 > 19) {
    m.good = 0
    const sameAsFailed = m.failed !== null && Math.abs(mean - m.failed) <= m.failed * .1
    if (level < top && now > m.hold && !sameAsFailed) { m.trial = { from: level, to: level + 1, mean }; next = level + 1 }
  } else if (p90 < 15.5) {
    if (++m.good >= 4) { next = Math.max(minLevel, level - 1); m.good = 0; m.failed = null }
  } else m.good = 0
  return { level: next, memo: m }
}
export const TRIAL = Object.freeze({ wait: 30000, longest: 600000 })

/** A promise kept when the graphics chip has finished everything sent to it so far (WebGPU: the queue's own
 *  signal; WebGL2: a fence, polled every millisecond). */
export function gpuFinished(renderer) {
  const backend = renderer.backend
  if (backend.device) return backend.device.queue.onSubmittedWorkDone()
  const gl = backend.gl
  if (!gl?.fenceSync) return Promise.resolve()
  const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); gl.flush()
  return new Promise(resolve => {
    const poll = () => { if (gl.clientWaitSync(sync, 0, 0) === gl.TIMEOUT_EXPIRED) setTimeout(poll, 1); else { gl.deleteSync(sync); resolve() } }
    poll()
  })
}

// The visit's decision. It outlives the canvas, so a change of quality tier (which builds a new one) reuses it.
//   kind: null until decided, then 'cap' or 'floor'; measuring: true while the test draws (Pond.jsx and Post.jsx
//   then run the moving-pointer load); settled: the chip has finished the test's last frames (the test keeps it
//   a second or so of work ahead, and the loading screen waits for that queue before it opens: Post.jsx);
//   scale: the share of the floor drawn when kind is 'low'; minLevel: the controller's lightest level;
//   results: the test's numbers (shown with ?stats, App.jsx).
export const resolution = { kind: null, scale: 1, minLevel: 0, measuring: false, settled: false, results: null }
if (import.meta.env?.DEV && typeof window !== 'undefined') window.__sharpness = resolution     // development checks

// ?dpr=<n> (development): draw at n, skip the test (comparisons at a fixed sharpness).
const pinned = import.meta.env?.DEV && typeof location !== 'undefined' ? Number(new URLSearchParams(location.search).get('dpr')) : 0
export const PINNED = pinned > 0 ? pinned : null
// ?slow=<n> (development): every frame is drawn n times, to stand in for a graphics chip n times slower.
// drawing.callback counts the frame callbacks in which Post.jsx drew, so that what is drawn only now and then
// (the pond's reflection, Pond.jsx) is drawn in every one of a frame's n copies or in none.
export const SLOW = import.meta.env?.DEV && typeof location !== 'undefined' ? Math.max(1, Math.round(Number(new URLSearchParams(location.search).get('slow')) || 1)) : 1
export const drawing = { callback: 0 }
