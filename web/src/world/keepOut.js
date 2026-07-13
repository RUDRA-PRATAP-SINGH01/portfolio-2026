// What the scroll camera must never show. Since the scene was dressed all round for the orbit (2026-11-14:
// blender/scripts/mf_orbit_extension.py; far trees, a south ridge, grass on every side) that is only what lies past
// the terrain's edges, where there is nothing at all. The dressed box is kept as its own entry: it was smaller than
// the terrain while the scene was dressed for one camera only (x -16..14, y 5.9..34), and the ?guard mask
// (Terrain.jsx) marks dry ground outside it. Ground under the water is never bare to the eye: the pond covers it.
// Used by the ?guard mask, the guard check (scripts/check-path-guard.mjs) and the path file's test.
// Blender coordinates: three.js (x, y, z) = Blender (x, z, -y).
const TERRAIN = Object.freeze({ x0: -34, x1: 34, y0: -23.6, y1: 44.4 })   // scene_meta.json terrain.bounds_blender_xy
export const KEEP_OUT = Object.freeze({ dressed: TERRAIN, terrain: TERRAIN })

/** Whether the ground point at three.js x, z, `height` metres high, is keep-out (bare, or beyond the terrain). */
export function keepOut(x, z, height, water = 0) {
  const y = -z, { dressed: d, terrain: t } = KEEP_OUT
  if (x < t.x0 || x > t.x1 || y < t.y0 || y > t.y1) return true
  return height > water && !(x >= d.x0 && x <= d.x1 && y >= d.y0 && y <= d.y1)
}

// The scene's distance fog (CinematicLights.jsx), in numbers (keepOut.test.js checks they are still the ones there):
//   fogged colour = mix(colour, fog colour, 1 - exp(-(0.028 x max(0, d - 10))^2 x density))
//   density = mix(0.8, 0.25, smoothstep(0, 12, (point height + eye height) / 2))
// d the distance from the eye. What the fog leaves of a surface is the exponential.
export const FOG = Object.freeze({ clear: 10, rate: .028, low: .8, high: .25, fade: 12 })

/** The share of a surface `distance` metres away that the fog leaves visible; `height` the mean of the point's and
 *  the eye's heights. */
export function fogVisible(distance, height = 0) {
  const t = Math.min(1, Math.max(0, height / FOG.fade)), density = FOG.low + (FOG.high - FOG.low) * t * t * (3 - 2 * t)
  return Math.exp(-((Math.max(0, distance - FOG.clear) * FOG.rate) ** 2) * density)
}
