// The list of grass blades to draw, built on the CPU for one camera pose (GrassSystem.update). Pure numbers and
// arrays, so a build can be cut into slices over several frames and resumed where it stopped; the one-frame
// rebuild is the same code with an unlimited slice, so both give the same list.

// A blade taller on screen than the first number (pixels) is drawn with all its segments, one shorter than the
// second as a single triangle, those between with two segments. Each blade changes at its own point within
// +-20% of these (its hash), so a tuft changes level blade by blade.
const LEVEL_PX = [70, 40]

/** How much of the slack ({ distance, angle }) lies between two poses ({ position, quaternion }): 1 = all of it. */
export function slackUsed(a, b, slack) {
  const p = a.position, q = b.position, r = a.quaternion, s = b.quaternion
  const angle = 2 * Math.acos(Math.min(1, Math.abs(r.x * s.x + r.y * s.y + r.z * s.z + r.w * s.w)))
  return Math.max(Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z) / slack.distance, angle / slack.angle)
}

// How many times the slack a list built during a flight gets. A list built ahead is drawn from where the camera is
// when it is finished (`reach` of its slack before its pose) until the next one is finished, about `frames` frames
// later (one build), and must hold to the end of its slack beyond its pose: 1 + reach slacks for `frames` frames at
// the flight's fastest (peakPerFrame, in view-change units of flight.js: one unit is one slack). A fifth to spare;
// at least 1 (the resting slack), at most 3.5.
export const SLACK_SCALE = Object.freeze({ spare: 1.2, most: 3.5 })
export const slackScale = (peakPerFrame, frames, reach) =>
  Math.min(SLACK_SCALE.most, Math.max(1, peakPerFrame * frames / (1 + reach) * SLACK_SCALE.spare))

/** The turn (radians) of a pitch `a` then a yaw `b` (XYZ Euler, as parallax.js turns the camera). */
export const turnOf = (a, b) => 2 * Math.acos(Math.min(1, Math.cos(a / 2) * Math.cos(b / 2)))

/** A build for one view. view: everything the list depends on, fixed when the build starts:
 *    matrix  the cull matrix widened by the slack (16 numbers, column-major)   eye  { x, y, z }
 *    sx, sy  the widened view's projection scales   slack  metres   pixel  size of a pixel at one metre
 *    lodFar, lodNear, lodMin, bladeKeep  the shader's thinning values   drawK  blades drawn per tuft, per batch
 *    legacy  every blade at full detail
 *  batches: [{ first, count, K, keepHashes, nominalHeight, runs: three arrays (near, mid, far) }]. The runs are
 *  the batch's scratch space: a build in progress owns them until it is written out or abandoned. */
export function startList(view, batches) {
  return { view, batch: 0, tuft: batches[0]?.first ?? 0, counts: batches.map(() => [0, 0, 0]), done: !batches.length }
}

/** Lists up to `tufts` more tufts (roots: x, groundY, z, yaw per tuft; scales: scale first, per tuft). True when done. */
export function stepList(build, batches, roots, scales, tufts = Infinity) {
  const { matrix: e, eye, sx, sy, slack, pixel, lodFar, lodNear, lodMin, bladeKeep, drawK, legacy } = build.view
  let left = tufts
  while (build.batch < batches.length && left > 0) {
    const b = batches[build.batch], K = drawK[build.batch], runs = b.runs, counts = build.counts[build.batch]
    const end = Math.min(b.first + b.count, build.tuft + left)
    let n0 = counts[0], n1 = counts[1], n2 = counts[2], i = build.tuft
    for (; i < end; i++) {
      const at = i * 4, x = roots[at], y = roots[at + 1], z = roots[at + 2]
      const distance = Math.max(.01, Math.hypot(x - eye.x, y - eye.y, z - eye.z) - slack)
      if (distance > lodFar + .02) continue
      // The tuft's root, 12 cm up, in the widened clip space (Vector4.applyMatrix4 with w = 1).
      const y12 = y + .12
      const px = e[0] * x + e[4] * y12 + e[8] * z + e[12], py = e[1] * x + e[5] * y12 + e[9] * z + e[13]
      const pw = e[3] * x + e[7] * y12 + e[11] * z + e[15]
      // Deliberately wider than the shader's clip test (w * 1.15 + .6), plus the reach of a camera move.
      const w = pw + slack, margin = w * 1.15 + .62
      if (w <= -.52 || Math.abs(px) >= margin + sx * slack || Math.abs(py) >= margin + sy * slack) continue
      const fade = Math.max(0, Math.min(1, (lodFar - distance) / (.2 * lodFar)))
      const fraction = Math.max(lodMin, Math.min(1, (lodNear / distance) ** 1.25)) * fade * fade * (3 - 2 * fade)
      const threshold = fraction * bladeKeep + .0001, hashes = (i - b.first) * b.K, id = i * 64
      // The tuft's blades on screen, in pixels (a typical blade of this kind at the tuft's scale).
      const tall = legacy ? Infinity : b.nominalHeight * scales[at] / (pixel * (distance + slack))
      for (let j = 0; j < K; j++) {
        const hash = b.keepHashes[hashes + j]
        if (hash > threshold) continue
        // hash / threshold: the blade's place among the tuft's kept blades, 0 to 1
        const size = tall * (.8 + .4 * hash / threshold)
        if (size > LEVEL_PX[0]) runs[0][n0++] = id + j
        else if (size > LEVEL_PX[1]) runs[1][n1++] = id + j
        else runs[2][n2++] = id + j
      }
    }
    counts[0] = n0; counts[1] = n1; counts[2] = n2
    left -= i - build.tuft
    if (i < b.first + b.count) { build.tuft = i; break }
    build.batch++; build.tuft = batches[build.batch]?.first ?? 0
  }
  return build.done = build.batch >= batches.length
}

/** Writes a batch's finished runs into its list, near | mid | far one after the other (the one list the shader
 *  reads). offsets receives where each run starts. Returns the span that changed, [first, end) (only that part is
 *  uploaded again), or null. */
export function writeList(ids, runs, counts, offsets) {
  let at = 0, first = -1, end = 0
  for (let level = 0; level < 3; level++) {
    const run = runs[level], n = counts[level]
    offsets[level] = at
    for (let k = 0; k < n; k++, at++) if (ids[at] !== run[k]) { ids[at] = run[k]; if (first < 0) first = at; end = at + 1 }
  }
  return first < 0 ? null : [first, end]
}

/** The layers of `perLayer` entries each that the span [first, end) touches. */
export function* layersOf([first, end], perLayer) {
  for (let layer = Math.floor(first / perLayer); layer * perLayer < end; layer++) yield layer
}
