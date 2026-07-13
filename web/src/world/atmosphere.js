import * as THREE from 'three/webgpu'
import { dot, exp, float, inverseSqrt, mix, normalize, rtt, screenUV, uniform, uv, vec3, vec4 } from 'three/tsl'
import { SKY_LEGACY, skyRadiance } from './sky.js'

// Pixels of the open sky: nothing in front of the far plane (the sky dome and its stars write no depth).
export const openSky = depth => depth.greaterThanEqual(.99999)

// Depth-based atmosphere, applied to the rendered frame before bloom and the display transform
// (displayPipeline.js). Two physically shaped terms, both integrated along each view ray up to the
// first surface, so nearer things are less veiled and stand out against what lies behind them:
//   ground mist   density falls off exponentially with height above the water; it pools over the pond and
//                 between the trunks and takes the colour of the sky near the horizon in that direction
//   lamp glow     light scattered in the air around the pink lamps (single scattering from a point light
//                 has a closed form), which turns the lamps into soft volumes and rims the statue
// Neither brightens open, near surfaces: the scene keeps its night exposure.
// All of this runs for every pixel of the frame, so whatever is constant over a frame is a uniform and
// the trigonometry is tabulated or approximated.
// The numbers are in world.palette: mist (density, height, reach, strength; clear: the first metres in front of
// the lens stay free of mist, so near surfaces keep their blacks; tint and saturation shape its colour) and
// lamps.airSoftness, lamps.airGain, lamps.airSky (metres of blur at the lamp; radiance per watt; how far past each
// lamp the glowing air reaches in front of the open sky).
const LAMPS = ['L_Moai_Rim_Back', 'L_Bank_Pink_R', 'L_Bank_Pink_L']   // the lamps strong enough to show in the air

// atan2(y, x) for y >= 0, to within 0.004 rad and with a single division.
function angle(y, x) {
  const ax = x.abs(), t = ax.min(y).div(ax.max(y).max(1e-6))
  const a = t.mul(t.oneMinus().mul(.273).add(Math.PI / 4))
  const b = y.greaterThan(ax).select(a.negate().add(Math.PI / 2), a)
  return x.lessThan(0).select(b.negate().add(Math.PI), b)
}

// World-space ray through each pixel, one metre long along the view axis, and the distance along that axis.
function viewRay(camera, depth) {
  const right = new THREE.Vector3(), up = new THREE.Vector3(), forward = new THREE.Vector3()
  const rays = uniform(new THREE.Matrix3()).onRenderUpdate((_, self) => {
    const p = camera.projectionMatrix.elements
    camera.matrixWorld.extractBasis(right, up, forward)
    right.divideScalar(p[0]); up.divideScalar(p[5]); forward.negate().addScaledVector(right, p[8]).addScaledVector(up, p[9])
    // Screen (u, v, 1) to ray: u runs left to right, v top to bottom.
    self.value.set(2 * right.x, -2 * up.x, forward.x - right.x + up.x, 2 * right.y, -2 * up.y, forward.y - right.y + up.y,
      2 * right.z, -2 * up.z, forward.z - right.z + up.z)
  })
  const range = uniform(new THREE.Vector3()).onRenderUpdate((_, self) => { self.value.set(camera.near * camera.far, camera.far, camera.far - camera.near) })
  return { ray: rays.mul(vec3(screenUV, 1)), axial: range.x.div(range.y.sub(range.z.mul(depth))) }
}

// The blurred sky just above the horizon, by compass direction: tabulated once over the unit disc of
// horizontal directions, so the mist's colour costs one small lookup instead of a panorama projection.
function horizonColour(world, direction) {
  if (!world.sky) return vec3(.02, .09, .26)
  const d = uv().mul(2).sub(1)
  const table = rtt(vec4(skyRadiance(world.sky, normalize(vec3(d.x, .05, d.y)), world.sky.fogLevel), 1), 64, 64, { autoUpdate: false })
  return table.sample(direction.xz.mul(.5).add(.5)).rgb
}

export function atmosphere(color, depth, camera, world) {
  const MIST = world.palette.mist, GLOW = { softness: world.palette.lamps.airSoftness, gain: world.palette.lamps.airGain, sky: world.palette.lamps.airSky ?? 120 }
  const origin = uniform(camera.position)
  const { ray, axial } = viewRay(camera, depth)
  const lengthSq = dot(ray, ray), perLength = inverseSqrt(lengthSq), direction = ray.mul(perLength)
  const far = axial.mul(lengthSq).mul(perLength)                       // distance to the first surface
  const water = world.meta.water_level
  // Mist: optical depth of an exponential height fog along the ray.
  const from = far.min(MIST.clear), to = far.min(MIST.reach), travelled = to.sub(from), slope = direction.y
  const thin = y => exp(y.sub(water).max(-.5).div(-MIST.height))
  const start = thin(origin.y.add(slope.mul(from))), end = thin(origin.y.add(slope.mul(to)))
  const depthAlong = slope.abs().greaterThan(1e-3)
    .select(start.sub(end).mul(MIST.height).div(slope), start.mul(travelled)).mul(MIST.density).max(0)
  const veil = float(1).sub(exp(depthAlong.negate())).mul(MIST.strength)
  let haze = horizonColour(world, direction)
  // saturation above 1 deepens the mist's own hue instead of letting it go pale (same brightness).
  if (MIST.saturation !== 1) haze = mix(vec3(dot(haze, vec3(.2126, .7152, .0722))), haze, MIST.saturation).max(0)
  let out = mix(color.rgb, haze.mul(vec3(...MIST.tint)), veil)
  // Lamp glow: for a lamp at L, the in-scattered light along the ray up to distance t is
  //   integral of 1 / (r^2 + s^2) = (atan((t - m) / h) + atan(m / h)) / h,  m = (L - o).d,  h^2 = |L - o|^2 - m^2 + s^2
  // and the two arctangents fold into one: atan2(t h, |L - o|^2 + s^2 - t m).
  const reach = far.min(120), open = openSky(depth)
  for (const name of LAMPS) {
    const lamp = world.meta.pink_lights?.find(l => l.name === name); if (!lamp) continue
    const [x, y, z] = lamp.position, power = lamp.watts * GLOW.gain
    // xyz: from the eye to the lamp; w: that distance squared plus the blur.
    const toLamp = uniform(new THREE.Vector4()).onRenderUpdate((_, self) => {
      const dx = x - camera.position.x, dy = y - camera.position.y, dz = z - camera.position.z
      self.value.set(dx, dy, dz, dx * dx + dy * dy + dz * dz + GLOW.softness ** 2)
    })
    const along = dot(toLamp.xyz, direction), h2 = toLamp.w.sub(along.mul(along)).max(1e-4), perH = inverseSqrt(h2)
    // In front of the open sky the glowing air ends lamps.airSky metres past the point nearest the lamp. Taken the
    // whole 120 m, the air around the eye glowed over every direction and lifted the sky 1.5 to 2.3 times, purple,
    // in the views near the statue; the halo around each lamp is gathered near that point and stays.
    const t = SKY_LEGACY.has('glow') ? reach : open.select(along.max(0).add(GLOW.sky).min(reach), reach)
    const scattered = angle(t.mul(h2).mul(perH), toLamp.w.sub(t.mul(along))).mul(perH)
    out = out.add(vec3(...lamp.color.map(c => c * power)).mul(scattered))
  }
  return vec4(out, 1)
}
