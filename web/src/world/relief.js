import { cameraViewMatrix, dot, float, normalLocal, normalWorld, positionWorld, transformNormalToView, varying, vec3 } from 'three/tsl'
import { gridLobes, luma } from './cinematic.js'
import { PBR_LEGACY } from './pbrLegacy.js'

// A light map holds how much light reaches a surface, not where it comes from, so on its own a normal map only shapes
// the moonlight; under the lamps and the sky, which light most of the ground near the statue, relief stayed flat.
// The light grid (lamps and sky, cinematic.js) knows the direction. Read at the vertices, it gives how that light
// changes with the way a surface faces, as a slope b (half the difference of opposite lobes): E(n) ~ E(N) + b.(n - N).
// Per pixel the light map is scaled by E(mapped) / E(geometric) = 1 + b.(mapped - N) / E(N), clamped. Linear in the
// normal, so relief that leans both ways averages out and the surface keeps its brightness: no grey lift, and black
// stays black (a scale). One vec3 passed per vertex; per pixel a subtraction, a dot product and a clamp.
// palette.pbr.relief: strength (1 = the grid's own slope), floor (share of the strongest lobe added under E(N), so
// a surface barely lit along its normal does not take the full slope), min / max (the clamp).
export function reliefScale(world, mapped) {
  const R = world.palette.pbr?.relief
  if (!R || !world.cinematic || PBR_LEGACY.has('relief')) return null
  const lobes = gridLobes(world, positionWorld, 'ground').map(luma)
  const n = transformNormalToView(normalLocal).transformNormalByInverseViewMatrix(cameraViewMatrix).normalize()
  const square = v => v.mul(v)
  const along = [n.x, n.x.negate(), n.y, n.y.negate(), n.z, n.z.negate()].reduce((sum, w, i) => sum.add(square(w.max(0)).mul(lobes[i])), float(0))
  const floor = lobes.reduce((a, b) => a.max(b)).mul(R.floor).add(1e-5)
  const slope = vec3(lobes[0].sub(lobes[1]), lobes[2].sub(lobes[3]), lobes[4].sub(lobes[5])).mul(.5 * R.strength).div(along.add(floor))
  // Only the tilt across the surface counts: the part along the normal (a tilted normal is shorter there) would darken
  // every bump a little, whichever way it leans.
  const tilt = mapped.sub(normalWorld.mul(dot(mapped, normalWorld)))
  return dot(varying(slope), tilt).add(1).clamp(R.min, R.max)
}
