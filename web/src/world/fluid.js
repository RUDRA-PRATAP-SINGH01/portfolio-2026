import * as THREE from 'three/webgpu'
import { Fn, Loop, abs, dot, exp, length, select, texture, uniform, uniformArray, uv, vec2, vec3, vec4 } from 'three/tsl'

// The cursor liquid of hatom.com, rebuilt for this renderer: a small 2D fluid simulation (stable fluids, as in
// Pavel Dobryakov's WebGL Fluid Simulation, MIT) that the pointer stirs. Its "ink" is the pointer's own motion,
// carried and swirled by the flow; the final pass (displayPipeline.js) pushes the finished frame along that ink.
// Settings, sizes and step order are hatom's (their class `dc`, read from their bundle on 2026-11-12):
//   velocity 128 x 128 (RG half float, linear), ink 512 x 512 (half float, linear),
//   divergence / curl / pressure 128 x 128 (R half float, nearest), 10 pressure iterations,
//   curl -2.5 (against the swirls: syrupy, no tight eddies), 0.95 fade of velocity and ink per 60 Hz frame,
//   0.95 of the last pressure kept as the solver's first guess, splat radius 0.03 / 100, moves capped at 20 px x 5.
// Everything is in screen coordinates with y down (uv() of a full-screen pass in three.js), so the pointer's y
// is not negated as in hatom's (y up) code: the flow is the same on screen. Checked against their simulation
// run side by side (same strokes, 60 frames at 60 Hz): velocity and ink agree to 0.1%, similarity 0.9994-1.
// Differences, none visible:
//   - hatom steps the fluid once per frame with a fixed 0.016 s, so the liquid runs faster and fades sooner at
//     120 or 144 Hz; here the step and the fade follow the real frame time (identical at 60 Hz);
//   - the splats of one frame are added in one pass (hatom: two passes per pointer sample; the sum is the same);
//   - the ink keeps only the two channels the distortion reads (hatom's third one feeds their white pages);
//   - after 4 s without a pointer move the fields are cleared and the simulation stops (at hatom's fade, what
//     is left by then is 0.95^240, about 5e-6 of the ink): an idle page pays nothing for it.
export const FLUID = Object.freeze({
  velocitySize: 128, inkSize: 512, pressureIterations: 10,
  velocityDissipation: .95, inkDissipation: .95, pressureDissipation: .95, curl: -2.5,
  radius: .03 / 100, maxMove: 20, moveGain: 5, step: .016, sleepAfter: 4,
})
const MAX_SPLATS = 32                                  // per pass; more pointer samples in a frame take more passes

function target(size, format, filter) {
  return new THREE.RenderTarget(size, size, { type: THREE.HalfFloatType, format, minFilter: filter, magFilter: filter,
    depthBuffer: false, generateMipmaps: false })
}
function pingPong(size, format, filter) {
  const pair = { read: target(size, format, filter), write: target(size, format, filter) }
  pair.swap = () => { const t = pair.read; pair.read = pair.write; pair.write = t }
  return pair
}
function quad(fragment) {
  const material = new THREE.NodeMaterial()
  material.fragmentNode = fragment
  material.depthTest = material.depthWrite = false
  material.blending = THREE.NoBlending
  return new THREE.QuadMesh(material)
}

export function createFluid(renderer, element = window) {
  const C = FLUID
  const velocity = pingPong(C.velocitySize, THREE.RGFormat, THREE.LinearFilter)
  const ink = pingPong(C.inkSize, THREE.RGFormat, THREE.LinearFilter)
  const pressure = pingPong(C.velocitySize, THREE.RedFormat, THREE.NearestFilter)
  const divergence = target(C.velocitySize, THREE.RedFormat, THREE.NearestFilter)
  const curl = target(C.velocitySize, THREE.RedFormat, THREE.NearestFilter)

  const texel = 1 / C.velocitySize, p = uv()
  const L = p.sub(vec2(texel, 0)), R = p.add(vec2(texel, 0)), T = p.add(vec2(0, texel)), B = p.sub(vec2(0, texel))
  const dt = uniform(C.step), keepVelocity = uniform(1), keepInk = uniform(1), keep = uniform(C.pressureDissipation)
  const splats = uniformArray(Array.from({ length: MAX_SPLATS }, () => new THREE.Vector4()), 'vec4')
  const splatCount = uniform(0, 'int'), aspect = uniform(1)

  // The passes, as functions of their input textures. Each pass gets one material per combination of inputs (the
  // ping-pong pairs make two or four), so no binding changes from frame to frame: re-pointing one material's
  // textures before every draw cost 3.4 ms of processor time per frame on the Intel laptop, and a pass drawn twice in
  // a frame with its inputs swapped in between kept its first inputs.
  const KINDS = {
    // A soft round dab per pointer sample, its colour the pointer's move (x, y).
    splat: input => Fn(() => {
      const value = input.sample(p).xy.toVar()
      Loop(splatCount, ({ i }) => {
        const s = splats.element(i), d = p.sub(s.xy).mul(vec2(aspect, 1))
        value.addAssign(exp(dot(d, d).negate().div(C.radius)).mul(s.zw))
      })
      return vec4(value, 0, 1)
    })(),
    curl: v => vec4(v.sample(R).y.sub(v.sample(L).y).sub(v.sample(T).x).add(v.sample(B).x).mul(.5), 0, 0, 1),
    vorticity: (v, w) => {
      const g = vec2(abs(w.sample(T).x).sub(abs(w.sample(B).x)), abs(w.sample(R).x).sub(abs(w.sample(L).x))).mul(.5)
      const f = g.div(length(g).add(.0001)).mul(w.sample(p).x.mul(C.curl))
      return vec4(v.sample(p).xy.add(vec2(f.x, f.y.negate()).mul(dt)), 0, 1)
    },
    // Walls at the screen's edges (the flow there is mirrored).
    divergence: v => {
      const c = v.sample(p).xy
      const l = select(L.x.lessThan(0), c.x.negate(), v.sample(L).x), r = select(R.x.greaterThan(1), c.x.negate(), v.sample(R).x)
      const t = select(T.y.greaterThan(1), c.y.negate(), v.sample(T).y), b = select(B.y.lessThan(0), c.y.negate(), v.sample(B).y)
      return vec4(r.sub(l).add(t).sub(b).mul(.5), 0, 0, 1)
    },
    // Pressure, by Jacobi iterations. The first one starts from the last frame's pressure times 0.95 (hatom scales
    // it in a pass of its own; folded in here, one pass fewer, the same numbers).
    jacobi: (q, d, scale = 1) => vec4(q.sample(L).x.add(q.sample(R).x).add(q.sample(B).x).add(q.sample(T).x).mul(scale)
      .sub(d.sample(p).x).mul(.25), 0, 0, 1),
    jacobiFirst: (q, d) => KINDS.jacobi(q, d, keep),
    gradient: (v, q) => vec4(v.sample(p).xy.sub(vec2(q.sample(R).x.sub(q.sample(L).x), q.sample(T).x.sub(q.sample(B).x))), 0, 1),
    // Each texel takes what the flow brings it from upstream (hatom uses the velocity grid's texel for the ink too,
    // so the ink moves exactly with the flow).
    advectVelocity: v => vec4(v.sample(p.sub(v.sample(p).xy.mul(dt).mul(texel))).xy.mul(keepVelocity), 0, 1),
    advectInk: (v, s) => vec4(s.sample(p.sub(v.sample(p).xy.mul(dt).mul(texel))).xy.mul(keepInk), 0, 1),
    clear: () => vec4(0),
  }
  const materials = new Map()
  const run = (kind, inputs, rt) => {
    const key = kind + inputs.map(t => ':' + t.id).join('')
    let pass = materials.get(key)
    if (!pass) materials.set(key, pass = quad(KINDS[kind](...inputs.map(t => texture(t)))))
    renderer.setRenderTarget(rt); pass.render(renderer)
  }
  const tex = rt => rt.texture
  /** The ink, to sample in screen uv (y down): xy is the push, in hatom's units. */
  const output = texture(ink.read.texture)

  function step(frames) {
    dt.value = C.step * frames
    // 1. splats into the velocity, then the same splats into the ink
    while (queue.length) {
      const batch = queue.splice(0, MAX_SPLATS * 4)
      for (let i = 0; i < batch.length / 4; i++) splats.array[i].fromArray(batch, i * 4)
      splatCount.value = batch.length / 4
      run('splat', [tex(velocity.read)], velocity.write); velocity.swap()
      run('splat', [tex(ink.read)], ink.write); ink.swap()
    }
    // 2. curl and vorticity
    run('curl', [tex(velocity.read)], curl)
    run('vorticity', [tex(velocity.read), tex(curl)], velocity.write); velocity.swap()
    // 3. pressure projection: the flow cannot bunch up or thin out
    run('divergence', [tex(velocity.read)], divergence)
    for (let i = 0; i < C.pressureIterations; i++) { run(i ? 'jacobi' : 'jacobiFirst', [tex(pressure.read), tex(divergence)], pressure.write); pressure.swap() }
    run('gradient', [tex(velocity.read), tex(pressure.read)], velocity.write); velocity.swap()
    // 4. the flow carries itself, then the ink
    keepVelocity.value = C.velocityDissipation ** frames; keepInk.value = C.inkDissipation ** frames
    run('advectVelocity', [tex(velocity.read)], velocity.write); velocity.swap()
    run('advectInk', [tex(velocity.read), tex(ink.read)], ink.write); ink.swap()
    output.value = ink.read.texture
  }
  const clearAll = () => { for (const rt of [velocity.read, velocity.write, ink.read, ink.write, pressure.read, pressure.write]) run('clear', [], rt) }

  // Pointer: every sample since the last frame (coalesced events), as hatom does.
  const queue = []
  let last = null, lastMove = -Infinity, lastSplat = -Infinity, asleep = true, enabled = true, hold = false
  const onMove = event => {
    const samples = event.getCoalescedEvents?.() ?? []
    const rect = element.getBoundingClientRect?.() ?? { left: 0, top: 0, width: innerWidth, height: innerHeight }
    for (const e of samples.length > 1 ? samples : [event]) {
      const x = e.clientX, y = e.clientY
      if (!last) last = { x, y }
      let dx = x - last.x, dy = y - last.y
      if (dx) dx /= Math.max(1, Math.abs(dx) / C.maxMove)
      if (dy) dy /= Math.max(1, Math.abs(dy) / C.maxMove)
      last = { x, y }
      if (!enabled || (!dx && !dy) || !rect.width || !rect.height) continue
      queue.push((x - rect.left) / rect.width, (y - rect.top) / rect.height, dx * C.moveGain, dy * C.moveGain)
      aspect.value = rect.width / rect.height
    }
  }
  addEventListener('pointermove', onMove, { passive: true })

  // Build every material now (while the page loads), not at the first pointer move: every step, with both
  // parities of every pair, then clear what that left behind.
  {
    const previous = renderer.getRenderTarget()
    queue.push(.5, .5, 0, 0)
    for (let i = 0; i < 4; i++) { step(1); if (i === 1) { velocity.swap(); ink.swap() } if (i === 2) pressure.swap() }
    queue.length = 0; clearAll(); output.value = ink.read.texture
    renderer.setRenderTarget(previous)
  }

  return {
    output,
    /** false: no new splats (reduced motion); what is already moving settles. */
    set enabled(value) { enabled = value },
    get asleep() { return asleep },
    /** true: keep simulating (and the liquid pass drawn) without any pointer, on whatever the fields hold; the
     *  sharpness test times the moving-pointer case this way (resolution.js). Let go, it sleeps at once unless the
     *  pointer really moved in the last few seconds. */
    set hold(value) { if (hold && !value) lastMove = lastSplat; hold = value },
    /** The ink's render target (development checks). */
    get inkTarget() { return ink.read },
    /** A pointer sample by hand (tests): position 0..1 (y down), move in px (already capped and scaled). */
    splat(x, y, dx, dy) { queue.push(x, y, dx, dy) },
    update(frameSeconds, now = performance.now() / 1000) {
      if (queue.length) { lastMove = lastSplat = now; asleep = false }
      if (hold && enabled) { lastMove = now; asleep = false }
      if (asleep) return
      const previous = renderer.getRenderTarget()
      if (now - lastMove > C.sleepAfter) { clearAll(); output.value = ink.read.texture; asleep = true }
      else step(THREE.MathUtils.clamp(frameSeconds * 60, .25, 3))
      renderer.setRenderTarget(previous)
    },
    dispose() {
      removeEventListener('pointermove', onMove)
      for (const rt of [velocity.read, velocity.write, ink.read, ink.write, pressure.read, pressure.write, divergence, curl]) rt.dispose()
      for (const pass of materials.values()) pass.material.dispose()
    },
  }
}

/**
 * hatom's distortion of the finished frame: 20% of it stays put, 80% is the average of four samples stepped
 * along the ink (uv -= ink * 0.0007 per step), so the picture streaks along the flow like seen through water.
 * `frame` is a texture node of the graded frame; `ink` the fluid's output.
 */
export function liquid(frame, ink) {
  const p = uv(), push = ink.sample(p).xy.mul(.0007)
  let smear = vec3(0)
  for (let i = 1; i <= 4; i++) smear = smear.add(frame.sample(p.sub(push.mul(i))).rgb)
  return vec4(frame.sample(p).rgb.mul(.2).add(smear.mul(.8 / 4)), 1)
}
