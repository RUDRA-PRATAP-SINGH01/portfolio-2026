import { createFlight, flightDuration, measureView } from './flight.js'

// Where the visitor has scrolled to, as the camera follows it along its path (CameraRig.jsx poses the camera at
// `eased` on the path of cameraPath.js; App.jsx's scroll track sets `target`). As hatom.com: one fixed path, scrubbed
// back and forth at the visitor's pace, no stops to wait at. The camera follows the scroll through one ease of 10% a
// 60 Hz frame (Lenis's default lerp; hatom eases twice at 4%, which trails the scroll by over a second), per time,
// and truly stops: within `rest` of the target it is put on it (the pond goes back to its resting rate).
// "Back to start" is a flight (flight.js: unseen.co's power4.inOut, 3 to 6 s by the share of the path flown, the
// shorter way round the orbit): scrubbed, a whole orbit back would pass in half a second. Any scroll ends it.
// It lives outside the canvas: a change of quality builds a new canvas, and the camera must stay where it is.
//   target  where the page is scrolled to (progress 0..1)   eased  where the camera is   moving  it is not there yet
export const SCROLL = Object.freeze({ ease: .1, rest: 1e-5 })
export const scroll = { target: 0, eased: 0, moving: false, flight: null, wrap: false, landed: null, measure: null, path: null,
  hold: false }                                       // (development captures: a flight's clock stands still)

/** The path (CameraRig, once the world is loaded): its view-change table (flight.js). */
export function setFlightPath(path) {
  if (!path || scroll.path === path) return
  scroll.path = path; scroll.measure = measureView(path)
}

/** The page has scrolled to `progress` (0..1). snap: the camera is put there at once (before the scene shows, for
 *  reduced motion, for checks). Either ends a flight. */
export function setScroll(progress, snap = false) {
  scroll.target = Math.min(1, Math.max(0, progress)); scroll.flight = null; scroll.wrap = false
  if (snap) scroll.eased = scroll.target
  scroll.moving = scroll.eased !== scroll.target
}

// (a stalled frame moves the camera as six frames would, at most; looking ahead has no such limit)
const follow = (seconds, most = 6) => 1 - (1 - SCROLL.ease) ** Math.min(most, Math.max(0, seconds * 60))

/** One frame of `seconds`: moves `eased` toward `target` (or along a flight) and returns it. */
export function stepScroll(seconds) {
  const f = scroll.flight
  if (f) {
    if (!scroll.hold) f.time += Math.min(.1, Math.max(0, seconds))
    scroll.eased = f.progressAt(f.time)
    if (f.time >= f.duration - 1e-6) {                   // (frame times summed in floating point fall just short)
      scroll.flight = null; scroll.eased = scroll.target = scroll.wrap && f.to === 1 ? 0 : f.to; scroll.wrap = false
      scroll.landed?.(scroll.target)
    }
  } else {
    scroll.eased += (scroll.target - scroll.eased) * follow(seconds)
    if (Math.abs(scroll.target - scroll.eased) < SCROLL.rest) scroll.eased = scroll.target
  }
  scroll.moving = scroll.eased !== scroll.target || !!scroll.flight
  return scroll.eased
}

/** Where the camera will be `seconds` from now (exact for a flight, and for the ease while the scroll holds still). */
export const scrollAhead = seconds => scroll.flight ? scroll.flight.progressAt(scroll.flight.time + seconds)
  : scroll.eased + (scroll.target - scroll.eased) * follow(seconds, Infinity)

/** How much the view changes in the next frame of `seconds` (flight.js's units: the grass list's slack), at most. */
export function scrollPace(seconds) {
  if (scroll.flight) return scroll.flight.peakPerFrame(seconds)
  const m = scroll.measure
  return m ? Math.abs(m.at(scrollAhead(seconds)) - m.at(scroll.eased)) : 0
}

/** Back to the opening view, flown the shorter way round the orbit (instant: put there at once). */
export function home(instant = false) {
  const here = scroll.eased, eps = 1e-6
  if (instant || here <= eps || here >= 1 - eps) { setScroll(0, true); scroll.landed?.(0); return }
  const m = scroll.measure, back = m ? m.at(here) : here, on = m ? m.total - m.at(here) : 1 - here, to = back <= on ? 0 : 1
  scroll.flight = createFlight(here, to, m, flightDuration(here, to, m))
  scroll.target = to; scroll.wrap = to === 1; scroll.moving = true
}
