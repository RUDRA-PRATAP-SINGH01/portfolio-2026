import * as THREE from 'three/webgpu'
import { cameraProjectionMatrix, cameraViewMatrix, dot, exp, exp2, float, instanceIndex, ivec2, positionGeometry, screenSize, textureLoad, uniform,
  varying, vec3, vec4 } from 'three/tsl'

// The sky's point stars (blender/scripts/pack_sky.py: the photo's own stars, each with its light and tint), drawn as
// points about a pixel wide at whatever resolution the frame has. Baked into the sky picture a star spread over 2 to 4
// screen pixels (10 on phones). Here each star is a small square facing the screen at the far plane, drawn after the
// sky dome: the depth test keeps it to the open sky, in the main view and in the pond's mirror alike, and the pixels
// it covers get a Gaussian of the star's light, all of it wherever the star sits between pixels, so a slowly turning
// view does not make the stars twinkle. A view draws only the stars its frame can show (visibleRuns), so the cost is
// a few thousand tiny squares at most, whatever the screen.
//
// The look (world.palette.stars): fwhm, the width of a star in pixels at half its peak; gain, a multiplier on every
// star's light; cap, the brightest a star's centre gets (scene-linear, under bloom's threshold); widen, how much a
// star brighter than the cap grows instead (its area by (peak / cap)^widen, up to fwhmMax pixels wide).

const HORIZON_TEXEL = (2 * Math.PI / 4096) * (Math.PI / 2048)   // sr: the unit of a star's light (pack_sky.py)
const ROW = 512                                                 // stars per row of the data texture
const SIGMA = 1 / (2 * Math.sqrt(2 * Math.LN2))                 // a Gaussian's sigma per unit of its full width at half maximum

/**
 * The stars of pack_sky.py's byte planes (azimuth, elevation, light, tint; sorted by azimuth).
 * u: each star's three.js equirect u (atan2(z, x) / 2pi + .5), ascending; data: four floats per star, its direction
 * x, y, z and its light byte * 256 + tint byte.
 */
export function decodeStars(bytes, count) {
  const plane = i => bytes.subarray(i * count, (i + 1) * count)
  const [uLow, uHigh, eLow, eHigh, light, tint] = [0, 1, 2, 3, 4, 5].map(plane)
  const u = new Float32Array(count), data = new Float32Array(count * 4)
  for (let i = 0; i < count; i++) {
    u[i] = (uLow[i] | uHigh[i] << 8) / 65536
    const azimuth = (u[i] - .5) * 2 * Math.PI, elevation = (eLow[i] | eHigh[i] << 8) / 65535 * Math.PI / 2
    data[i * 4] = Math.cos(elevation) * Math.cos(azimuth); data[i * 4 + 1] = Math.sin(elevation)
    data[i * 4 + 2] = Math.cos(elevation) * Math.sin(azimuth); data[i * 4 + 3] = light[i] * 256 + tint[i]
  }
  return { u, data }
}

// Elevation bands (degrees). The stars are grouped by band, each band sorted by azimuth, and a view draws from every
// band only the run of azimuths its frame covers there: about the stars in its frame, plus their neighbours in band.
export const BANDS = [0, 6, 12, 18, 24, 30, 37, 45, 55, 67, 90.01]

/** The stars (u ascending, as decodeStars gives them) regrouped by BANDS: the order to store them in, and per band
 *  where its stars start in that order and their u, ascending. */
export function groupStars(u, data, edges = BANDS) {
  const lists = edges.slice(1).map(() => [])
  for (let i = 0; i < u.length; i++) {
    const elevation = Math.asin(Math.min(1, data[i * 4 + 1])) * 180 / Math.PI
    let b = 0; while (b < lists.length - 1 && elevation >= edges[b + 1]) b++
    lists[b].push(i)
  }
  const order = new Uint32Array(u.length); let first = 0
  const bands = lists.map(list => {
    order.set(list, first)
    const band = { first, u: Float32Array.from(list, i => u[i]) }
    first += list.length
    return band
  })
  return { order, bands }
}

// The frame's border, widened by GROW so that a star just outside it still lights the pixels at its edge (a star's
// square reaches up to 5 px past its centre), sampled SIDE times along each side.
const GROW = 1.05, SIDE = 24

/**
 * Per band of `bands` (groupStars), the run of its stars the camera's frame can show: { start, count }, start
 * within the band, wrapping past its end. The frame's border is followed in world space (only the projection's x and
 * y rows are used, so the pond's mirror camera, whose depth row is tilted to the water, gives the same answer); where
 * it lies in a band, or crosses one of its edges, gives the azimuths the frame covers in that band.
 */
export function visibleRuns(bands, camera, edges = BANDS) {
  const P = camera.projectionMatrix.elements, M = camera.matrixWorld.elements
  const all = bands.map(band => ({ start: 0, count: band.u.length }))
  // The zenith in the frame: every azimuth is.
  const zx = M[1], zy = M[5], zz = M[9]
  if (zz < 0 && Math.abs((P[0] * zx + P[8] * zz) / -zz) <= GROW && Math.abs((P[5] * zy + P[9] * zz) / -zz) <= GROW) return all
  // Each border point's direction (x, z), elevation in degrees and azimuth in turns (three's equirect u).
  const N = 4 * SIDE, X = new Float64Array(N), Z = new Float64Array(N), E = new Float64Array(N), T = new Float64Array(N)
  for (let k = 0; k < N; k++) {
    const t = (k % SIDE) / SIDE * 2 - 1, side = Math.floor(k / SIDE)
    const sx = [t, 1, -t, -1][side] * GROW, sy = [-1, t, 1, -t][side] * GROW
    const x = (sx + P[8]) / P[0], y = (sy + P[9]) / P[5]                 // view space, at z = -1
    const wx = M[0] * x + M[4] * y - M[8], wy = M[1] * x + M[5] * y - M[9], wz = M[2] * x + M[6] * y - M[10]
    const length = Math.hypot(wx, wy, wz)
    X[k] = wx; Z[k] = wz; E[k] = Math.asin(wy / length) * 180 / Math.PI; T[k] = Math.atan2(wz, wx) / (2 * Math.PI) + .5
    if (E[k] > 84) return all                                             // close to the zenith: azimuth means little
  }
  return bands.map((band, b) => {
    const low = edges[b], high = edges[b + 1], turns = []
    for (let k = 0; k < N; k++) {
      if (E[k] >= low && E[k] <= high) turns.push(T[k])
      const q = (k + 1) % N
      for (const e of [low, high]) {
        if ((E[k] - e) * (E[q] - e) >= 0) continue
        const f = (e - E[k]) / (E[q] - E[k])                                 // where the border crosses the band's edge
        turns.push(Math.atan2(Z[k] + (Z[q] - Z[k]) * f, X[k] + (X[q] - X[k]) * f) / (2 * Math.PI) + .5)
      }
    }
    const n = band.u.length
    if (!turns.length || !n) return { start: 0, count: 0 }
    turns.sort((a, c) => a - c)
    let gap = turns[0] + 1 - turns[turns.length - 1], end = turns.length - 1
    for (let k = 0; k + 1 < turns.length; k++) if (turns[k + 1] - turns[k] > gap) { gap = turns[k + 1] - turns[k]; end = k }
    // Half a degree of sky between samples, in azimuth at the band's top.
    const margin = .5 / 360 / Math.cos(Math.min(high, 85) * Math.PI / 180)
    if (gap < 2 * margin + .002) return all[b]
    const from = ((turns[(end + 1) % turns.length] - margin) % 1 + 1) % 1, to = ((turns[end] + margin) % 1 + 1) % 1
    const first = lowerBound(band.u, from), last = lowerBound(band.u, to)  // [first, last): the stars from `from` to `to`
    return { start: first % n, count: from <= to ? last - first : n - first + last }
  })
}

/** createStars' one draw for `runs` (visibleRuns): per band [its first copy, where its stars start in the table, how
 *  many it has, where its run starts among them], and the number of copies. A copy draws for the last band whose
 *  first copy is at or before it, the star at row[1] + (row[3] + copy - row[0]) mod row[2]. */
export function drawPlan(bands, runs) {
  let drawn = 0
  const plan = runs.map(({ start, count }, b) => { const row = [drawn, bands[b].first, Math.max(1, bands[b].u.length), start]; drawn += count; return row })
  return { plan, drawn }
}

function lowerBound(sorted, value) {
  let lo = 0, hi = sorted.length
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < value) lo = mid + 1; else hi = mid }
  return lo
}

/** The star layer for `sky` (sky.js loadSky) in the look `look` (palette.json stars): a mesh to add to the scene. */
export function createStars(sky, look) {
  const { count, u, data, flux_log2: [low, high], colour } = sky.stars
  const { order, bands } = groupStars(u, data)
  const rows = Math.ceil(count / ROW), cells = new Float32Array(ROW * rows * 4)
  order.forEach((star, i) => cells.set(data.subarray(star * 4, star * 4 + 4), i * 4))
  const table = new THREE.DataTexture(cells, ROW, rows, THREE.RGBAFormat, THREE.FloatType)   // nearest, no mipmaps
  table.needsUpdate = true
  // One draw for all the bands' runs, one after another (drawPlan).
  const runs = bands.map(() => uniform(new THREE.Vector4(0, 0, 1, 0)))
  const copy = float(instanceIndex)
  const run = runs.slice(1).reduce((taken, next) => copy.greaterThanEqual(next.x).select(next, taken), runs[0])
  // (+.5 then floor: an approximate float mod at an exact multiple may return the band's size instead of 0)
  const index = run.y.add(run.w.add(copy.sub(run.x)).add(.5).mod(run.z).floor())
  const star = textureLoad(table, ivec2(index.mod(ROW), index.div(ROW).floor()))
  const view = cameraViewMatrix.mul(vec4(star.xyz, 0)).xyz
  const clip = cameraProjectionMatrix.mul(vec4(view, 1))
  // A pixel's solid angle in this direction: 4 / (P0 W P5 H) at the middle of a flat frame, times the cube of the
  // cosine of the angle off its axis. The star's light, in radiance times pixels:
  const off = view.z.negate().max(1e-3)
  const pixel = float(4).div(cameraProjectionMatrix.element(0).x.mul(cameraProjectionMatrix.element(1).y).mul(screenSize.x).mul(screenSize.y)).mul(off.mul(off).mul(off))
  const lightByte = star.w.div(256).floor(), tintByte = star.w.sub(lightByte.mul(256))
  const light = exp2(lightByte.mul((high - low) / 255).add(low)).mul(HORIZON_TEXEL * look.gain).div(pixel)
  const s0 = look.fwhm * SIGMA, sMax = look.fwhmMax * SIGMA
  const over = light.div(2 * Math.PI * s0 * s0 * look.cap).max(1)
  const spread = over.pow(look.widen).mul(s0 * s0).min(sMax * sMax)             // sigma squared, pixels
  const peak = light.div(spread.mul(2 * Math.PI)).min(look.cap)
  const tint = vec3(...colour.mean).add(vec3(...colour.axis).mul(tintByte.div(255).sub(.5).mul(2 * colour.reach)))
  // Out to three sigma and the half pixel to the nearest pixel centre.
  const offset = positionGeometry.xy.mul(spread.sqrt().mul(3).add(.75))
  const material = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, depthWrite: false, fog: false, blending: THREE.AdditiveBlending })
  material.vertexNode = vec4(clip.xy.add(offset.mul(2).div(screenSize).mul(clip.w)), clip.w, clip.w)
  const at = varying(offset), falloff = varying(spread.mul(-2))
  material.colorNode = varying(tint.mul(peak)).mul(exp(dot(at, at).div(falloff)))
  const geometry = new THREE.InstancedBufferGeometry()
  geometry.setIndex([0, 1, 2, 0, 2, 3])
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3))
  geometry.instanceCount = 0
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'SkyStars'; mesh.frustumCulled = false; mesh.renderOrder = 1001; mesh.matrixAutoUpdate = false
  // Worked out again only when a camera (the view's or the pond mirror's) has moved.
  const last = new WeakMap()
  mesh.onBeforeRender = (renderer, scene, camera) => {
    const pose = [...camera.matrixWorld.elements, ...camera.projectionMatrix.elements], known = last.get(camera)
    if (!known || known.pose.some((v, i) => v !== pose[i])) last.set(camera, { pose, ...drawPlan(bands, visibleRuns(bands, camera)) })
    const { plan, drawn } = last.get(camera)
    plan.forEach((row, b) => runs[b].value.fromArray(row))
    geometry.instanceCount = drawn
  }
  mesh.userData.dispose = () => { geometry.dispose(); material.dispose(); table.dispose() }
  return mesh
}
