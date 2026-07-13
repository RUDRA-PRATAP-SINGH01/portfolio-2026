import * as THREE from 'three/webgpu'

// unseen.co's pointer swing (their home scene's camera, theme.js, read 2026-11-16), turning round hatom's point.
// Their camera turns round a point in front of it (in to the point, turned, back out). The pointer, -1..1 across the
// window (y up), is eased 7.5% a 60 Hz frame (90% of the way in 0.49 s) and the view turns toward it: up to 0.135 rad
// sideways and 0.035 rad up and down. A second pointer, eased 2% a frame, trails it; the camera rolls by 0.05 rad
// times their difference across, so it banks into a quick move and levels out as the second one catches up.
// On top their camera drifts slowly, as if held by hand (their "brownian motion": three octaves of value noise; turns
// up to 0.0132 x 4/3 x 7/8 rad on two axes). Here the drift is centred on the pose (the view's average stays the
// Blender reference) and turns round the same point, a little slower than theirs (a 4 s cycle: the pond's mirror,
// redrawn at its resting rate while only the drift moves, stays within half a pixel).
// The point: where hatom's sway turned, 0.63 x the distance to the view's subject (7.6 m at the opening view: the
// glass name hangs there, glassName.js, so it stays put while the forest swings behind it). Their own point sits
// about as far into their scene. Easing follows the real frame time (identical to theirs at 60 Hz).
export const PARALLAX = Object.freeze({
  ease: .075, trail: .02,             // the pointer's ease, the trailing pointer's (per 60 Hz frame)
  yaw: .135, pitch: .035, roll: .05,  // radians at the window's edge; roll per unit of difference
  pivot: .1 / 3.96 / .04,             // the turning point: 0.631 x the distance to the subject
  drift: { turn: .0132 * 4 / 3 * 7 / 8 / 2, rate: .25, octaves: 3 },   // +-0.0077 rad, noise cells per second
})

// value noise as theirs (smooth steps between random values on a lattice), from a fixed table (repeatable)
const TABLE = (() => { let s = 0x9e3779b9; return Float64Array.from({ length: 256 }, () => { s = (s ^ (s << 13)) >>> 0; s = (s ^ (s >>> 17)) >>> 0; s = (s ^ (s << 5)) >>> 0; return s / 4294967296 }) })()
const noise = x => { const i = Math.floor(x), f = x - i, t = f * f * (3 - 2 * f); return TABLE[i & 255] * (1 - t) + TABLE[(i + 1) & 255] * t }
/** Three octaves of value noise, centred: -1..1 (at most). */
export const fractal = x => { let sum = 0, amp = .5, f = x; for (let o = 0; o < PARALLAX.drift.octaves; o++) { sum += amp * noise(f); f *= 2; amp *= .5 } return (sum / .875) * 2 - 1 }

/** How far the camera can move from its pose at a subject `distance` away (for clearance tests): sideways, up/down
 *  and back, at the swing's and the drift's full extent. */
export function swingReach(distance) {
  const p = PARALLAX.pivot * distance, d = PARALLAX.drift.turn
  const side = PARALLAX.yaw + d, up = PARALLAX.pitch + d
  return { side: p * Math.sin(side), up: p * Math.sin(up), back: p * (1 - Math.cos(Math.hypot(side, up))) }
}

/** The camera's pose after the swing but before the drift (the pond and the grass work from it: the drift alone never
 *  moves the view by more than a pixel between their updates). */
export const steady = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), valid: false }
/** The camera's pose on its path, before the swing (the glass name measures the scroll's motion from it, not the
 *  pointer's: glassName.js). */
export const base = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), valid: false }
/** The swing now posing the camera (CameraRig), for work built ahead of time (GrassSystem.js). */
export const active = { sway: null }

const _e = new THREE.Euler(), _q = new THREE.Quaternion(), _r = new THREE.Quaternion(), _pivot = new THREE.Vector3(), _back = new THREE.Vector3()

/** Turns a pose (in place) round its point `p` metres ahead: yaw, pitch, then roll about the view. */
export function turnAbout(position, quaternion, p, pitch, yaw, roll = 0) {
  _pivot.set(0, 0, -p).applyQuaternion(quaternion).add(position)
  quaternion.multiply(_q.setFromEuler(_e.set(pitch, yaw, 0, 'XYZ')))
  if (roll) quaternion.multiply(_r.setFromEuler(_e.set(0, 0, roll, 'XYZ')))
  position.copy(_back.set(0, 0, p).applyQuaternion(quaternion).add(_pivot))
}

export function createParallax() {
  const pointer = new THREE.Vector2(), eased = new THREE.Vector2(), trailing = new THREE.Vector2()
  const state = { yaw: 0, pitch: 0, roll: 0, time: 0, distance: 12, drift: true, strength: 1, hold: null }
  const sway = {
    pointer, eased, trailing, state,
    /** clientX / clientY on a window of width x height. */
    point(x, y, width, height) { pointer.set(x / width * 2 - 1, (1 - y / height) * 2 - 1) },
    /** Advance by `seconds`; `distance` = how far ahead the view's subject is; `strength` 0..1 (reduced motion: 0);
     *  drift: the handheld drift is on. settle: go at once to where the easing would settle (checks). */
    step(seconds, distance, strength = 1, settle = false, drift = true) {
      const frames = THREE.MathUtils.clamp(seconds * 60, 0, 6)
      eased.lerp(pointer, settle ? 1 : 1 - (1 - PARALLAX.ease) ** frames)
      trailing.lerp(pointer, settle ? 1 : 1 - (1 - PARALLAX.trail) ** frames)
      Object.assign(state, sway.angles(eased, trailing, strength), { distance, strength, drift: drift && strength > 0 })
      if (state.drift) state.time += Math.max(0, seconds)
    },
    /** The swing's angles for an eased and a trailing pointer. */
    angles(fast, slow, strength = state.strength) {
      return { yaw: -fast.x * PARALLAX.yaw * strength, pitch: fast.y * PARALLAX.pitch * strength, roll: -(fast.x - slow.x) * PARALLAX.roll * strength }
    },
    /** The swing's angles `frames` 60 Hz frames ahead, the pointer held where it is (for work built ahead of time). */
    ahead(frames) {
      const k1 = 1 - (1 - PARALLAX.ease) ** frames, k2 = 1 - (1 - PARALLAX.trail) ** frames
      const fast = eased.clone().lerp(pointer, k1), slow = trailing.clone().lerp(pointer, k2)
      return sway.angles(fast, slow)
    },
    /** The drift's turns at `time` seconds (radians: pitch, yaw), or zero when it is off. */
    driftAt(time = state.time) {
      if (!state.drift) return [0, 0]
      const t = time * PARALLAX.drift.rate, a = PARALLAX.drift.turn * state.strength
      return [fractal(t + 17.3) * a, fractal(t + 101.9) * a]
    },
    /** Pose the camera: its own pose, turned round its point by the swing (that is `steady`), then by the drift. */
    apply(camera) {
      const p = PARALLAX.pivot * state.distance, hold = state.hold
      base.position.copy(camera.position); base.quaternion.copy(camera.quaternion); base.valid = true
      turnAbout(camera.position, camera.quaternion, p, state.pitch, state.yaw, hold?.roll ?? state.roll)
      steady.position.copy(camera.position); steady.quaternion.copy(camera.quaternion); steady.valid = true
      const [pitch, yaw] = hold?.drift ?? sway.driftAt()
      if (pitch || yaw) turnAbout(camera.position, camera.quaternion, p, pitch, yaw)
    },
  }
  return sway
}
