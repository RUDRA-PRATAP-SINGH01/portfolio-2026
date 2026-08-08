import { SCROLL, scroll, stepScroll } from '../world/scroll.js'

// The white section after the camera's path, rebuilt from alche.studio's (studied 2026-11-18, nothing copied):
// past the path's end the camera holds still, a light screen rises from the bottom over the scene, only the stone
// head's outline stays on it, and the page's content comes up on the light.
// Positions are viewport heights scrolled past the path's end (App.jsx writes outro.target from the scroll track).
//   hold   the camera settles on the path's last pose and the pointer swing fades out (alche: works_outro)
//   wipe   the light screen rises (alche: mission_in, one viewport)
//   rest   the content stays (alche: mission, 160vh)
export const OUTRO = Object.freeze({ hold: .5, wipe: 1, rest: 1.6 })
export const OUTRO_LENGTH = OUTRO.hold + OUTRO.wipe + OUTRO.rest

// ?outro=0 leaves it off: the page ends with the path (comparisons and the older checks).
export const OUTRO_ON = typeof location === 'undefined' || new URLSearchParams(location.search).get('outro') !== '0'

/** The live state, shared by the scroll track (App.jsx), the camera (CameraRig.jsx), the wipe on the canvas
 *  (wipe.js) and the content (Outro.jsx).
 *    target  viewport heights past the path's end, as the page is scrolled (App.jsx)
 *    eased   where the outro is: it follows target as the camera follows the scroll (stepPage)
 *    ratio   the path's progress per viewport of outro (App.jsx, from the track's lengths) */
export const outro = { target: 0, eased: 0, ratio: 0 }
if (import.meta.env?.DEV && typeof window !== 'undefined') window.__outro = outro

const clamp01 = x => Math.min(1, Math.max(0, x))

/** alche's follower: one frame of `seconds` moves `current` toward `target` at rate m (time constant ~1/(10 m) s). */
export const lerp = (current, target, seconds, m) => current + (target - current) * Math.min(1, Math.max(0, seconds) * 10 * m)

/** How far the hold has gone (0..1). */
export const holdProgress = after => clamp01(after / OUTRO.hold)

/** How far the light screen has risen, as the page is scrolled (0..1; alche's mission_in.progress). */
export const wipeProgress = after => clamp01((after - OUTRO.hold) / OUTRO.wipe)

/** One frame of `seconds`: `eased` follows `goal` (the target) as the camera follows the scroll (scroll.js, 10% a
 *  60 Hz frame; alche's Lenis smooths its page about the same), and stops on it. */
export function stepOutro(seconds, goal = outro.target) {
  const k = 1 - (1 - SCROLL.ease) ** Math.min(6, Math.max(0, seconds * 60))
  outro.eased += (goal - outro.eased) * k
  if (Math.abs(goal - outro.eased) < 1e-4) outro.eased = goal
  return outro.eased
}

/** One frame of the page (CameraRig.jsx, once a frame, before anything reads it). As alche's one Lenis scroll, the
 *  camera's place on the path and the outro are one place, eased once: the outro moves only with the camera on the
 *  path's end, the camera only with the outro at its start. Returns the camera's place on the path. */
export function stepPage(seconds) {
  const r = outro.ratio                                   // path per viewport of outro (App.jsx); none yet, or a flight
  if (!r || scroll.flight) { stepOutro(seconds); return stepScroll(seconds) }
  const goal = scroll.target + outro.target * r, k = 1 - (1 - SCROLL.ease) ** Math.min(6, Math.max(0, seconds * 60))
  const place = scroll.eased + outro.eased * r, next = place + (goal - place) * k
  if (Math.abs(goal - next) < SCROLL.rest) { scroll.eased = scroll.target; outro.eased = outro.target }
  else { scroll.eased = Math.min(1, next); outro.eased = Math.max(0, next - 1) / r }
  scroll.moving = scroll.eased !== scroll.target
  return scroll.eased
}

/** The scroll track's place (App.jsx): `top` pixels scrolled, `length` the path's pixels (.scroll-spacer), `unit` a
 *  viewport of the outro in pixels. progress is the camera's place on the path, after the viewports past its end. */
export const trackPlace = (top, length, unit) => ({ progress: Math.min(1, top / length), after: Math.max(0, top - length) / unit })

// Where the page comes to rest in the outro (App.jsx, desktop), alche's snap points 7834, 8901 and 9969 px of a 900 px
// window (their path ends at 7300): the teaser (the light 84 px up), the content, and 1068 px further.
export const REST = Object.freeze([OUTRO.hold + OUTRO.wipe * 84 / 900, OUTRO.hold + OUTRO.wipe + 251 / 900, OUTRO.hold + OUTRO.wipe + 1319 / 900])

/** The rest nearest `after`, or null on the path (alche snaps anywhere past its path's end). */
export const restPoint = after => after > 0
  ? REST.reduce((best, rest) => Math.abs(rest - after) < Math.abs(best - after) ? rest : best) : null
