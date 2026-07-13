import * as THREE from 'three/webgpu'

// "Back to start" as a flight (scroll.js), and the path's view-change measure the grass paces its lists by.
// The flight is unseen.co's camera move (their theme.js, read 2026-11-16): a change of page tweens
// the camera's place on its curve over 3 s with GSAP's power4.inOut: 1.3% of the way in the first 0.6 s, 87% in the
// middle 1.2 s, the peak four times the average speed. Their place is measured along the curve by arc length.
// Ours (the one adaptation): their camera hardly turns, ours orbits the statue at an even pace of view change
// (camera_scroll.py). So the path is measured by how much the view changes,
// frame by frame: max(metres / 0.4, degrees / 2.5) (the grass list's slack, GrassSystem.js). Their curve then sets
// the pace of moving and turning alike, with no second easing on top.
export const FLIGHT = Object.freeze({
  duration: 3,                        // seconds for the shortest flight (theirs)
  perHalf: 3,                         // +3 s per half of the path's view change flown ("Back to start": 3 to 6 s)
  view: { metres: .4, degrees: 2.5 }, // one unit of view change
})

/** GSAP's power4.inOut. */
export const power4InOut = t => t <= 0 ? 0 : t >= 1 ? 1 : t < .5 ? 8 * t ** 4 : 1 - 8 * (1 - t) ** 4

/** How much the view changes along a path, frame by frame.
 *  path: { frames, poseAt(progress, position, quaternion) }.
 *  Returns { frames, total, at(progress) -> units from the start, progressAt(units) -> progress }. */
export function measureView(path, frames = path.frames) {
  const units = new Float64Array(frames + 1)
  const p0 = new THREE.Vector3(), p1 = new THREE.Vector3(), q0 = new THREE.Quaternion(), q1 = new THREE.Quaternion()
  path.poseAt(0, p0, q0)
  for (let i = 1; i <= frames; i++) {
    path.poseAt(i / frames, p1, q1)
    const degrees = THREE.MathUtils.radToDeg(2 * Math.acos(Math.min(1, Math.abs(q0.dot(q1)))))
    // (a tiny floor keeps the table strictly rising, so every progress has one place)
    units[i] = units[i - 1] + Math.max(p0.distanceTo(p1) / FLIGHT.view.metres, degrees / FLIGHT.view.degrees, 1e-9)
    p0.copy(p1); q0.copy(q1)
  }
  return {
    frames, total: units[frames],
    at(progress) {
      const f = Math.min(1, Math.max(0, progress)) * frames, i = Math.min(frames - 1, Math.floor(f))
      return units[i] + (units[i + 1] - units[i]) * (f - i)
    },
    progressAt(value) {
      if (value <= 0) return 0
      if (value >= units[frames]) return 1
      let lo = 0, hi = frames
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (units[mid] <= value) lo = mid; else hi = mid }
      return (lo + (value - units[lo]) / (units[hi] - units[lo])) / frames
    },
  }
}

/** Seconds for a flight between two progresses (measure: measureView, or none: progress itself is the measure). */
export function flightDuration(from, to, measure) {
  const share = measure ? Math.abs(measure.at(to) - measure.at(from)) / measure.total : Math.abs(to - from)
  return FLIGHT.duration + FLIGHT.perHalf * 2 * Math.min(1, share)
}

/** A flight from progress `from` to `to` (measure: measureView). progressAt(seconds since takeoff). */
export function createFlight(from, to, measure, duration) {
  const a = measure ? measure.at(from) : from, b = measure ? measure.at(to) : to
  return {
    from, to, duration, time: 0,
    units: Math.abs(b - a),
    progressAt(seconds) {
      const t = seconds / duration
      if (t >= 1) return to
      const value = a + (b - a) * power4InOut(t)
      return measure ? measure.progressAt(value) : value
    },
    /** The most view change in one frame of `seconds` (the curve's peak: four times the average). */
    peakPerFrame(seconds = 1 / 60) { return 4 * Math.abs(b - a) / duration * seconds },
  }
}
