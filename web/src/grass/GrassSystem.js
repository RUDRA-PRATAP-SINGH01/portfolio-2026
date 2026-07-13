import * as THREE from 'three/webgpu'
import {
  Fn, uniform, instancedArray, instanceIndex, positionLocal, vec2, vec3, vec4, float, uint, ivec2, hash, sin, cos, mix,
  smoothstep, max, min, abs, normalize, dot, cross, length, pow, exp, textureLoad, textureLevel, texture, cameraPosition,
  cameraProjectionMatrix, cameraViewMatrix, deltaTime, varying, select, sqrt,
} from 'three/tsl'
import { makeAlbedoLUT, makeNoiseTexture } from './grassTextures.js'
import { lin } from '../world/data.js'
import { fieldLight, lampGrade, softLight } from '../world/cinematic.js'
import { adaptive } from '../world/AdaptiveQuality.jsx'
import { motionTime as time } from '../world/animation.js'
import { widenedView } from '../world/viewChange.js'
import { scroll, scrollAhead, scrollPace } from '../world/scroll.js'
import { PARALLAX, active, steady, turnAbout } from '../world/parallax.js'
import { ORBIT } from '../world/CameraRig.jsx'
import { warmup } from '../loading/warmup.js'
import { download } from '../world/bytes.js'
import { layersOf, slackScale, slackUsed, startList, stepList, turnOf, writeList } from './grassList.js'

const LIST_ROWS = 16                // rows of 256 in each layer of a kind's list texture (16 KB)

/*
  Procedural grass, v2 — "Blender tufts, GPU blades".
  Blender exports its real grass tufts (position, yaw, scale, variation, kind). Each tuft grows K blades on the GPU
  using the same recipe as the Blender prototypes, so density and placement match the Blender scene 1:1.
  - LOD: per-blade stochastic thinning with distance; survivors widen so coverage is preserved; ≥ ~1 px width.
  - Blade shape by size on screen (LEVEL_PX, grassList.js): all segments close up, two segments further away, a single
    triangle in the distance. Measured on the Intel laptop (2026-11-12): the blades cost by their vertices, at any
    resolution (2.4 ms for 636k triangles), and a blade 20 px tall looks the same as one triangle.
  - Per-tuft view-frustum test (culled tufts become degenerate triangles).
  - Only blades that can be visible are submitted: update() lists them on the CPU, and re-lists them only
    after the view has changed by more than the list's slack (the list is built for a view widened by that much:
    CULL_SLACK, several times that for a list built during a fast flight, plus the reach of the handheld drift).
    On the scroll path the next list is built ahead of the camera in slices over several frames (grassList.js).
  - WebGPU: per-tuft compute pass smooths wind + pointer interaction ("charge" glow). WebGL2: analytic wind.
  - Tuft data lives in a float texture (textureLoad), so both backends share one code path.
*/

const TAU = Math.PI * 2
// How far the camera may move (m) and turn (rad) before the visible-blade list is rebuilt, at rest. A list built
// during a flight has slackScale (grassList.js) times as much: enough for the camera's fastest frames until the next
// list is finished. (The view-change unit of the flights, flight.js, is this slack.)
const CULL_SLACK = { distance: .4, angle: 2.5 * Math.PI / 180 }
// Working ahead on the scroll path: a new list is started once the camera has used `start` of the drawn list's
// slack (during a flight, in the frame the last one is finished), for where the camera will be when it is finished
// and then `reach` of its own slack on toward where the camera flies; it is built `chunk` tufts at a time for about
// `sliceMs` of each frame (the whole list took about 1.8 ms on the Intel laptop, 2026-11-14).
const AHEAD = { start: .2, reach: .9, sliceMs: .6, chunk: 512 }
const LEVEL_NAMES = ['near', 'mid', 'far']
const flags = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams()
// ?grassLegacy (development): every blade with all its segments, as before, for comparisons.
const LEGACY = !!import.meta.env?.DEV && flags.has('grassLegacy')
// ?grassNoAhead (development): lists are only rebuilt past the slack, in one frame, as before (for comparisons).
const NO_AHEAD = !!import.meta.env?.DEV && flags.has('grassNoAhead')
// ?marks: each slice of a list build and each commit are timed as performance measures (scripts/perf/scroll.mjs).
const MARKS = flags.has('marks')
// Same PCG integer hash as Three's TSL hash(), including float32 conversion.
function bladeHash(seed) {
  const state = (Math.imul(seed,747796405)+2891336453)>>>0
  const word = Math.imul((state>>>((state>>>28)+4))^state,277803737)>>>0
  return Math.fround(((word>>>22)^word)>>>0)/4294967296
}
const KINDS = {
  // Blender PROTO_Grass_*: 16-26 blades, root radius 0-4 cm, height 0.16-0.34 m, half-width 2.5-4.5 mm, bend 0.25-0.75, droop 0-0.25
  mondo: { kind: 0, blades: 24, radius: 0.04, h: [0.16, 0.34], hw: [0.0025, 0.0045], bend: [0.25, 0.75], droop: [0.0, 0.25], tint: 1.0 },
  // Poly Haven grass_medium_01 tufts (retinted dark in Blender): wider, lower, bushier
  meadow: { kind: 1, blades: 48, radius: 0.13, h: [0.08, 0.2], hw: [0.003, 0.005], bend: [0.35, 0.9], droop: [0.05, 0.35], tint: 0.95 },
}

export function makeBladeGeometry(segments) {
  const pos = [], idx = []
  for (let r = 0; r < segments; r++) { const h = r / segments; pos.push(-0.5, h, 0, 0.5, h, 0) }
  pos.push(0, 1, 0)
  for (let r = 0; r < segments - 1; r++) { const a = r * 2; idx.push(a, a + 1, a + 3, a, a + 3, a + 2) }
  const last = (segments - 1) * 2
  idx.push(last, last + 1, segments * 2)
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setIndex(idx)
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4)
  return g
}

export async function loadTufts(meta) {
  const t = meta.grass_tufts
  const raw = new Float32Array(await download('/' + t.file, { label: 'Grass asset' }))
  const n = t.count, s = t.stride_floats
  if (raw.length !== n * s) throw new Error('Invalid grass data')
  // sort by kind so each kind is one contiguous range (one draw call per kind)
  const order = [...Array(n).keys()].sort((a, b) => raw[a * s + 6] - raw[b * s + 6])
  const W = 256, H = Math.ceil(n / W)
  const A = new Float32Array(W * H * 4), B = new Float32Array(W * H * 4)
  const ranges = { 0: [0, 0], 1: [0, 0] }
  order.forEach((src, i) => {
    const o = src * s
    A.set([raw[o], raw[o + 7], raw[o + 2], raw[o + 3]], i * 4)            // x, groundY, z, yaw
    B.set([raw[o + 4], raw[o + 5], raw[o + 6], 0], i * 4)                  // scale, var, kind
    const k = raw[o + 6]
    if (ranges[k][1] === 0) ranges[k][0] = i
    ranges[k][1]++
  })
  const tex = (d) => { const x = new THREE.DataTexture(d, W, H, THREE.RGBAFormat, THREE.FloatType); x.needsUpdate = true; return x }
  return { count: n, width: W, texA: tex(A), texB: tex(B), ranges }
}

export class GrassSystem {
  constructor({ world, renderer, tier, tufts }) {
    this.world = world; this.renderer = renderer; this.tufts = tufts; this.tier = tier
    this.useCompute = !!renderer.backend?.isWebGPUBackend
    this.group = new THREE.Group(); this.group.name = 'ProceduralGrass'
    this.cullMatrix = new THREE.Matrix4()
    // The pose, slack (cover: { distance, angle }; scale: times CULL_SLACK) and projection the drawn list was built
    // for; a list being built ahead (grassList.js); the poses lists are built for (here: the camera's, ahead: the one
    // ahead), with the distance their drift turns round (parallax.js).
    this.list = { position: new THREE.Vector3(Infinity, 0, 0), quaternion: new THREE.Quaternion(), projection: new Float64Array(16).fill(NaN), cover: CULL_SLACK, scale: 1 }
    this.pending = null; this.buildFrames = 4; this.recentFrames = []  // frames from a build's start to its commit
    this.frameSeconds = 1 / 60
    const pose = () => ({ position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), scale: new THREE.Vector3(1, 1, 1), matrixWorldInverse: new THREE.Matrix4(), projectionMatrix: null, distance: 12 })
    this.here = pose(); this.ahead = pose()
    this.lastCullScale = NaN; this.lastLodFar = NaN
    const meta = world.meta, P = world.palette.grass
    const U = (this.u = {
      uvScale: uniform(world.uvScale), uvOffset: uniform(world.uvOffset),
      moonDir: uniform(new THREE.Vector3(...meta.moon.direction_to_scene).normalize()),
      moonColor: uniform(lin(meta.moon.color).multiplyScalar(world.palette.moon.grass * world.palette.moon.gain)),
      skyColor: uniform(lin(P.sky)), groundColor: uniform(lin(P.ground)),
      rimColor: uniform(lin(P.rim)), transColor: uniform(lin(P.translucent)), glowColor: uniform(lin(world.palette.glow.grass)),
      rounding: uniform(0.77),
      lodNear: uniform(tier.lodNear), lodMin: uniform(tier.lodMin), lodFar: uniform(tier.lodFar), bladeKeep: uniform(tier.bladeKeep),
      pixelAngle: uniform(0.001), widthBoost: uniform(1.6),
      windDir: uniform(new THREE.Vector2(Math.cos(0.18 * TAU), Math.sin(0.18 * TAU))),
      windSpeed: uniform(0.9), windFreq: uniform(0.11), windStrength: uniform(0.16), gust: uniform(0.42), turbulence: uniform(0.16), flutter: uniform(0.06),
      pointer: uniform(new THREE.Vector3(0, -100, 0)), pointerVel: uniform(new THREE.Vector2()), pointerActive: uniform(0),
    })
    this.albedoLUT = makeAlbedoLUT(meta.grass.root_color, meta.grass.tip_color.map((c) => c * P.tipGain), P.variants)
    this.noiseTex = makeNoiseTexture()
    if (this.useCompute) {
      this.state = instancedArray(tufts.count, 'vec4')
      this.computeNode = Fn(() => {
        const st = this.state.element(instanceIndex)
        const A = this.tuftA(instanceIndex)
        const root = A.xz
        const p = root.sub(U.pointer.xz), d2 = dot(p, p)
        const fall = exp(d2.mul(-2.0)).mul(U.pointerActive)
        const push = normalize(p.add(vec2(1e-4))).mul(fall.mul(0.6)).add(U.pointerVel.mul(fall.mul(0.25)))
        const target = this.wind(root, hash(instanceIndex).mul(TAU)).add(push)
        st.xy.assign(mix(st.xy, target, deltaTime.mul(5).saturate()))
        st.z.assign(st.z.mul(deltaTime.mul(1.2).oneMinus().max(0)).add(fall.mul(deltaTime).mul(4)).saturate())
      })().compute(tufts.count)
    }
    this.batches = []
    for (const [name, spec] of Object.entries(KINDS)) {
      const [first, count] = tufts.ranges[spec.kind]
      if (count > 0) this.batches.push(this.makeBatch(name, spec, first, count))
    }
    for (const b of this.batches) for (const mesh of b.levels) this.group.add(mesh)
    this.lastViewport = NaN
    // For the checks in scripts/perf: blades and triangles sent per level, and the system (its lists).
    if (import.meta.env?.DEV) { const self = this; this.group.userData.grass = { system: this, get levels() { return self.levelStats() } } }
  }

  tuftA(i) { return textureLoad(this.tufts.texA, ivec2(i.mod(this.tufts.width).toInt(), i.div(this.tufts.width).toInt())) }
  tuftB(i) { return textureLoad(this.tufts.texB, ivec2(i.mod(this.tufts.width).toInt(), i.div(this.tufts.width).toInt())) }
  groundData(xz) { return textureLevel(this.world.dataTexture, xz.mul(this.u.uvScale).add(this.u.uvOffset), 0) }

  wind(xz, phase) {
    const U = this.u, D = U.windDir, P = vec2(D.y.negate(), D.x)
    const t = time.mul(U.windSpeed)
    const a = dot(xz, D).mul(U.windFreq).add(t), b = dot(xz, P).mul(U.windFreq)
    const w1 = sin(a.add(phase))
    const w2 = sin(a.mul(0.41).add(b.mul(0.83)).add(t.mul(0.29)).add(phase.mul(0.7)))
    const w3 = sin(a.mul(2.2).sub(b.mul(1.6)).add(t.mul(1.8)).add(phase.mul(1.4)))
    const along = U.windStrength.mul(w1.mul(0.6).add(w2.mul(U.gust)).add(w3.mul(U.turbulence).mul(0.4)))
    const across = U.windStrength.mul(w2.mul(0.22).add(w3.mul(0.05)))
    const flutter = sin(time.mul(6).add(xz.x.mul(0.35)).add(xz.y.mul(0.22)).add(phase)).mul(U.flutter)
    return D.mul(along.add(flutter.mul(0.35))).add(P.mul(across.add(flutter.mul(0.2))))
  }

  makeBatch(name, spec, first, count) {
    const U = this.u, K = spec.blades
    const b = { name, spec, first, count, K, densityWidth:uniform(1) }
    // Compact the existing tuft IDs before drawing. Keep the original IDs in
    // the shader so every blade's shape, random seed and compute state agree.
    // One number per listed blade: tuft * 64 + blade (exact in a 32-bit float; K is at most 48).
    // In layers of LIST_ROWS rows of 256: a new list is sent again only in the layers where it changed (three's WebGPU
    // backend sends a whole 2D texture every time, 1.86 MB a commit, up to 15 ms on a laptop's slow cores).
    const layers = Math.ceil(count*K / (256 * LIST_ROWS))
    b.visibleIds = new Float32Array(256 * LIST_ROWS * layers)
    b.keepHashes = new Float32Array(count*K)
    for (let i=0;i<count;i++) for(let j=0;j<K;j++) {
      b.visibleIds[i*K+j]=(first+i)*64+j
      b.keepHashes[i*K+j]=bladeHash(((first+i)*K+j)*7+spec.kind*104729)
    }
    b.indexTexture = new THREE.DataArrayTexture(b.visibleIds,256,LIST_ROWS,layers)
    b.indexTexture.format = THREE.RedFormat; b.indexTexture.type = THREE.FloatType
    b.indexTexture.needsUpdate = true
    // Runs of the list: near | mid | far (update()). Scratch space for one run each while the list is rebuilt.
    b.runs = [0, 1, 2].map(() => new Float32Array(count*K)); b.runCount = [count*K, 0, 0]
    b.nominalHeight = (spec.h[0] + spec.h[1]) / 2 * (this.world.palette.grass.height ?? 1)
    // Where a mesh's run starts in the list: one material and one list serve the three shapes of a kind.
    const listOffset = uniform(0, 'uint').onObjectUpdate(({ object }) => object.userData.listOffset ?? 0)
    const vH = varying(float(0), 'vH'), vU = varying(float(0), 'vU'), vVar = varying(float(0), 'vVar')
    const vWorld = varying(vec3(0), 'vWorld'), vN0 = varying(vec3(0, 1, 0), 'vN0'), vT = varying(vec3(0, 1, 0), 'vT')
    const vCanopy = varying(float(1), 'vCanopy'), vSky = varying(float(1), 'vSky'), vCharge = varying(float(0), 'vCharge')
    const material = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide })

    material.positionNode = Fn(() => {
      const h = positionLocal.y, s = positionLocal.x
      const slot = instanceIndex.add(listOffset)
      const row = slot.div(uint(256))
      const listed = textureLoad(b.indexTexture,ivec2(slot.mod(uint(256)).toInt(),row.mod(uint(LIST_ROWS)).toInt())).depth(row.div(uint(LIST_ROWS)).toInt()).x
      const tuft = listed.div(64).floor(), ti = tuft.toUint()
      const seedIndex=ti.mul(uint(K)).add(listed.sub(tuft.mul(64)).toUint())
      const A = this.tuftA(ti), B = this.tuftB(ti)
      const center = A.xz, groundY = A.y, yaw = A.w, scale = B.x
      const r = (k) => hash(seedIndex.mul(uint(7)).add(uint(k * 7919 + spec.kind * 104729)))
      // ---- LOD: distance thinning (coverage kept by widening survivors), max distance, view frustum
      const camD = length(vec3(center.x, groundY, center.y).sub(cameraPosition))
      const frac = min(pow(U.lodNear.div(max(camD, 0.01)), 1.25), 1).max(U.lodMin).mul(smoothstep(U.lodFar, U.lodFar.mul(0.8), camD))
      const keepBlade = r(0).lessThan(frac.mul(U.bladeKeep))
      const clip = cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(center.x, groundY.add(0.12), center.y, 1))
      const m = clip.w.mul(1.15).add(0.6)
      const inView = clip.w.greaterThan(-0.5).and(abs(clip.x).lessThan(m)).and(abs(clip.y).lessThan(m))
      const keep = keepBlade.and(inView)
      // ---- blade recipe (same as the Blender prototype)
      const a = r(1).mul(TAU)
      const rad = sqrt(r(2)).mul(spec.radius).mul(scale)
      const root = center.add(vec2(cos(a.add(yaw)), sin(a.add(yaw))).mul(rad))
      const bladeYaw = a.add(yaw).add(r(3).sub(0.5).mul(1.2))
      const dir = vec2(cos(bladeYaw), sin(bladeYaw))
      // palette grass.height: blade length relative to the Blender tufts (2026-11-12: the user asked for longer grass)
      const H = select(keep, mix(spec.h[0], spec.h[1], r(4)).mul(scale).mul(this.world.palette.grass.height ?? 1), 0)
      const coverage = frac.max(0.05).sqrt().reciprocal().mul(b.densityWidth)
      const wPix = U.pixelAngle.mul(camD).mul(0.9)
      const W = select(keep, max(mix(spec.hw[0], spec.hw[1], r(5)).mul(2).mul(scale).mul(U.widthBoost).mul(coverage), wPix), 0)
      const bendAmt = mix(spec.bend[0], spec.bend[1], r(6)).mul(H)
      const droop = mix(spec.droop[0], spec.droop[1], r(7)).mul(H)
      // The shares of the moon (g) and of the sky (b) that reach the blade's root, from the same baked map as the ground under it.
      const reach = textureLevel(this.world.cinematic.ground, root.mul(this.u.uvScale).add(this.u.uvOffset), 1)
      const windS = this.useCompute ? this.state.element(ti) : vec4(this.wind(center, hash(ti).mul(TAU)), 0, 0)
      const windOff = windS.xy.mul(H.mul(2.2))
      const h2 = h.mul(h), h3 = h2.mul(h)
      const off = dir.mul(bendAmt).add(windOff).mul(h2)
      const dOff = dir.mul(bendAmt).add(windOff).mul(h.mul(2))
      const up = h.mul(H).sub(droop.mul(h3)).sub(dot(off, off).mul(0.2).div(max(H, 0.02)))
      const axis = vec3(root.x.add(off.x), groundY.add(up), root.y.add(off.y))
      const side = vec3(dir.y.negate(), 0, dir.x)
      const pos = axis.add(side.mul(s).mul(W).mul(h.pow(0.9).oneMinus().mul(0.9).add(0.1)))
      const T = normalize(vec3(dOff.x, max(H, 1e-3).sub(droop.mul(h2).mul(3)), dOff.y))
      vH.assign(h); vU.assign(s.add(0.5)); vVar.assign(B.y.mul(0.7).add(r(8).mul(0.3))); vWorld.assign(pos)
      vN0.assign(normalize(cross(side, T))); vT.assign(T); vCanopy.assign(reach.g); vSky.assign(reach.b)
      vCharge.assign(windS.z)
      return pos
    })()

    material.colorNode = Fn(() => {
      const ang = vU.mul(2).sub(1).mul(U.rounding).mul(Math.PI * 0.4)
      const T = normalize(vT), N0 = normalize(vN0)
      let N = normalize(N0.mul(cos(ang)).add(cross(T, N0).mul(sin(ang))))
      const V = normalize(cameraPosition.sub(vWorld))
      N = select(dot(N, V).lessThan(0), N.negate(), N)
      const Ldir = normalize(U.moonDir), L = Ldir.negate()
      const albedo = pow(texture(this.albedoLUT, vec2(vVar, vH)).rgb, vec3(2)).mul(this.world.palette.grass.kinds[name] ?? spec.tint)
      const ao = mix(0.22, 1.0, smoothstep(0.0, 0.65, vH))
      const wrap = dot(N, L).add(0.45).div(1.45).saturate()
      const trans = pow(dot(V, Ldir).saturate(), 3).mul(vH.mul(0.65).add(0.35))
      const Hv = normalize(L.add(V))
      const spec_ = pow(dot(N, Hv).saturate(), mix(12, 48, vH)).mul(vH).mul(0.35)
      const moon = U.moonColor.mul(vCanopy).mul(albedo.mul(wrap).add(U.transColor.mul(albedo).mul(trans).mul(2.2)).add(spec_))
      const rim = U.rimColor.mul(pow(abs(dot(N, V)).oneMinus(), 4)).mul(vH).mul(0.18)
      // Sky light, dimmed by the baked share of the sky that reaches the ground here: grass under the trees is
      // as shaded as the ground it grows from.
      const amb = mix(U.groundColor, U.skyColor, N.y.mul(0.5).add(0.5)).mul(vSky).mul(albedo).mul(ao)
      // Lamp light from the baked light grid.
      const lamps = this.world.palette.lamps
      let lamp = lampGrade(this.world, fieldLight(this.world,vWorld,N,'lamps'), vWorld)
      if (lamps.knee.grass) lamp = softLight(lamp, lamps.knee.grass, lamps.minSaturation)   // a bright pool keeps the blades' own colour
      const pinks = lamp.mul(albedo).mul(ao)
      const sheen = texture(this.noiseTex, vWorld.xz.mul(0.07).add(time.mul(0.012))).r.mul(0.25).add(0.88)
      const glow = U.glowColor.mul(vCharge).mul(vH).mul(1.6)
      return vec4(moon.add(amb).add(pinks).mul(sheen).add(rim).add(glow), 1)
    })()

    const segments = [this.tier.segments, Math.min(2, this.tier.segments), 1]
    b.levels = segments.map((n, level) => {
      const mesh = new THREE.Mesh(makeBladeGeometry(n), material)
      mesh.count = level === 0 ? count * K : 0; mesh.visible = mesh.count > 0
      mesh.frustumCulled = false
      mesh.name = `Grass_${name}_${LEVEL_NAMES[level]}`
      mesh.userData.listOffset = 0; mesh.userData.bladeTriangles = n * 2 - 1
      return mesh
    })
    b.material = material
    return b
  }

  setPointer(point, velocity) {
    if (!point) { this.u.pointerActive.value = 0; return }
    this.u.pointer.value.copy(point); this.u.pointerVel.value.set(velocity?.x ?? 0, velocity?.y ?? 0); this.u.pointerActive.value = 1
  }

  update(camera, viewportHeight, seconds) {
    this.u.bladeKeep.value=this.tier.bladeKeep
    this.u.lodFar.value=this.tier.lodFar*(.6+.4*adaptive.foliageScale)
    camera.updateMatrixWorld()
    const lodFar=this.u.lodFar.value, list=this.list, projection=camera.projectionMatrix.elements
    // World size of one pixel at one metre (also a pixel's angular size, for the minimum-width rule).
    const pixel = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / Math.max(1, viewportHeight)
    // Lists are built for the camera's pose before its handheld drift (parallax.js steady) and widened by the
    // drift's reach (listView), so the drift alone never uses up a list.
    const here = this.poseOf(steady.valid ? steady : camera, camera, this.here, active.sway?.state.distance ?? 12)
    // A frame's time (smoothed: one long frame does not throw the pose ahead too far), and the slack of the lists
    // started now: wider while the camera moves fast along its path (scroll.js; in ?orbit it does not ride it).
    const frame = this.frameSeconds += (Math.min(.1, Math.max(1 / 240, seconds)) - this.frameSeconds) * .1
    const pace = !ORBIT && this.world.cameraPath ? scrollPace(frame) : 0
    const scaleNow = () => slackScale(pace, this.buildFrames, AHEAD.reach)
    let same=this.lastCullScale===adaptive.foliageScale && this.lastLodFar===lodFar && this.lastViewport===viewportHeight
    for(let i=0;i<16;i++) same&&=list.projection[i]===projection[i]
    // On the scroll path the next list is built ahead, a slice per frame (below). Once finished it is drawn, in the
    // frame after its last slice, if the camera is within its slack (otherwise it is dropped and the next one starts).
    if(this.pending?.done && same) {
      if(slackUsed(this.pending.view,here,this.pending.view.cover)<=1) this.commit(this.pending)
      // The frames a build takes: the most of the last four (a build's frames vary by one or two with its size and
      // the processor's other work, and a list must last until the next one is drawn).
      const recent=this.recentFrames; recent.push(this.pending.frames); if(recent.length>4) recent.shift()
      this.buildFrames=Math.max(...recent); this.pending=null
    }
    // The list is built for a view widened and a camera brought closer by its slack, so it holds while the camera
    // stays within that slack of the pose it was built for; the vertex shader applies the exact tests and collapses
    // the surplus. Past the slack, or after a change of projection or quality, it is rebuilt in this frame; while the
    // camera moves along its path for a pose ahead, as a list built ahead is (one centred on it would be outrun again).
    if(slackUsed(list,here,list.cover)>1 || !same) {
      const start = MARKS ? performance.now() : 0, scale = scaleNow()
      this.pending=null
      const ahead = pace > 0 && this.lookAhead(camera,0,scale) && slackUsed(this.ahead,here,{ distance: CULL_SLACK.distance * scale, angle: CULL_SLACK.angle * scale })<=1
      const build=startList(this.listView(ahead?this.ahead:here,pixel,lodFar,scale),this.batches)
      this.slice(build,Infinity); this.commit(build)
      list.projection.set(projection)
      this.lastCullScale=adaptive.foliageScale;this.lastLodFar=lodFar;this.lastViewport=viewportHeight
      if (MARKS) performance.measure('grass-rebuild', { start })
    }
    else if(this.pending) { this.slice(this.pending,AHEAD.sliceMs); this.pending.frames++ }
    // A new build may start in the frame the last one is drawn (commit() has written it out of the scratch runs), for
    // where the camera will be one frame before it can be drawn: a build that ends a frame early still finds the camera
    // within its slack. No build starts for about the pose the list already has (a slowing camera can still be on its
    // way to it), except to narrow a list widened for a flight once the camera rests.
    else if(!NO_AHEAD) {
      const scale = scaleNow(), narrow = scale === 1 && list.scale > 1
      if((narrow || slackUsed(list,here,list.cover)>=AHEAD.start) && this.lookAhead(camera,Math.max(0,this.buildFrames-1)*frame,scale)
        && (narrow || slackUsed(this.ahead,list,list.cover)>=AHEAD.start)) {
        this.pending=startList(this.listView(this.ahead,pixel,lodFar,scale),this.batches)
        this.slice(this.pending,AHEAD.sliceMs); this.pending.frames=1
      }
    }
    // Behind the loading screen every shape is drawn at least once, so nothing is built at the first camera move.
    for(const b of this.batches) b.levels.forEach((mesh,level)=>{ mesh.count=Math.max(b.runCount[level],warmup.active?1:0); mesh.visible=mesh.count>0 })
    this.u.pixelAngle.value = pixel
    if (this.useCompute) this.renderer.compute(this.computeNode)
  }

  // A pose to build a list for (`to`: this.here or this.ahead) from `from`'s position and turn and the camera's
  // projection. distance: what its drift turns round (parallax.js: the distance to the view's subject, at most 12 m).
  poseOf(from, camera, to, distance) {
    to.position.copy(from.position); to.quaternion.copy(from.quaternion); to.distance = distance
    to.projectionMatrix = camera.projectionMatrix
    to.matrixWorldInverse.compose(to.position, to.quaternion, to.scale).invert()
    return to
  }

  // How far the handheld drift (parallax.js) can turn the view away from its steady pose, and move the eye: both its
  // turns at their extremes (or as a check holds them), round its point PARALLAX.pivot x `distance` (at most 12 m) ahead.
  driftReach(distance) {
    const s = active.sway?.state, held = s?.hold?.drift
    const a = held ? Math.abs(held[0]) : s?.drift ? PARALLAX.drift.turn * s.strength : 0, b = held ? Math.abs(held[1]) : a
    const angle = turnOf(a, b)
    return { angle, distance: PARALLAX.pivot * Math.min(12, distance) * angle }
  }

  // What a list build for `pose` (here or ahead) depends on, fixed when it starts (grassList.js): the view widened by
  // `scale` times CULL_SLACK (`cover`, what the slack tests measure the steady pose against) and by the drift's reach
  // (while a list is drawn the camera may get up to 1 + reach of its slack farther from the subject, and the drift's
  // point with it: the reach is taken that far out).
  listView(pose, pixel, lodFar, scale) {
    const cover = { distance: CULL_SLACK.distance * scale, angle: CULL_SLACK.angle * scale }
    const drift = this.driftReach(pose.distance + cover.distance * (1 + AHEAD.reach))
    const { sx, sy } = widenedView(pose, cover.angle + drift.angle, this.cullMatrix), p = pose.position, u = this.u
    return { matrix: this.cullMatrix.elements.slice(), eye: { x: p.x, y: p.y, z: p.z }, sx, sy, slack: cover.distance + drift.distance, pixel,
      lodFar, lodNear: u.lodNear.value, lodMin: u.lodMin.value, bladeKeep: u.bladeKeep.value, legacy: LEGACY,
      drawK: this.batches.map(b => Math.max(4, Math.round(b.K * adaptive.foliageScale))),
      position: p.clone(), quaternion: pose.quaternion.clone(), cover, scale }
  }

  // Lists tufts for about `ms` of main-thread time (all of them with Infinity).
  slice(build, ms) {
    const start = performance.now(), roots = this.tufts.texA.image.data, scales = this.tufts.texB.image.data
    if (ms === Infinity) stepList(build, this.batches, roots, scales)
    else while (!stepList(build, this.batches, roots, scales, AHEAD.chunk) && performance.now() - start < ms);
    if (MARKS) performance.measure('grass-list', { start })
  }

  // The finished build becomes the drawn list; its index texture is sent again where it changed.
  commit(build) {
    const start = MARKS ? performance.now() : 0, offsets = [0, 0, 0]
    this.batches.forEach((b, k) => {
      const counts = build.counts[k]
      const changed = writeList(b.visibleIds, b.runs, counts, offsets)
      if (changed) { for (const layer of layersOf(changed, 256 * LIST_ROWS)) b.indexTexture.addLayerUpdate(layer); b.indexTexture.needsUpdate = true }
      b.levels.forEach((mesh, level) => { mesh.userData.listOffset = offsets[level]; b.runCount[level] = counts[level] })
      b.densityWidth.value = Math.sqrt(b.K / build.view.drawK[k])
    })
    this.list.position.copy(build.view.position); this.list.quaternion.copy(build.view.quaternion)
    this.list.cover = build.view.cover; this.list.scale = build.view.scale
    if (MARKS) performance.measure('grass-commit', { start })
  }

  // The pose to build the next list for, on the scroll path (world.cameraPath): the steady pose (before the drift)
  // the camera will have `seconds` from now (the flight's own place then, which scroll.js knows exactly, turned by
  // the swing as its eases will have run on by then with the pointer held), then `reach` of the new list's slack
  // (`scale` times CULL_SLACK) on toward where the camera is flying, measured in the path's view change (flight.js,
  // whose unit is CULL_SLACK), never past its destination. Into this.ahead.
  // False when the camera does not ride the path (?orbit, CameraRig.jsx) or there is none.
  lookAhead(camera, seconds, scale) {
    const path = this.world.cameraPath; if (!path || ORBIT) return false
    const ahead = this.ahead, sway = active.sway, centre = this.world.statue?.centre
    let p = scrollAhead(seconds)
    const measure = scroll.measure, target = scroll.target
    if (measure && p !== target) {
      const from = measure.at(p), end = measure.at(target), on = from + Math.sign(end - from) * AHEAD.reach * scale
      p = (end > from ? on >= end : on <= end) ? target : measure.progressAt(on)
    }
    path.poseAt(p, ahead.position, ahead.quaternion)
    // (as CameraRig.jsx: the swing turns round a point at a share of the distance to the statue, at most 12 m)
    const distance = centre ? Math.min(12, ahead.position.distanceTo(centre)) : 12, swing = sway?.ahead(seconds * 60)
    if (swing) turnAbout(ahead.position, ahead.quaternion, PARALLAX.pivot * distance, swing.pitch, swing.yaw, sway.state.hold?.roll ?? swing.roll)
    this.poseOf(ahead, camera, ahead, distance)
    return true
  }

  levelStats() {
    return LEVEL_NAMES.map((name, level) => {
      let blades = 0, triangles = 0
      for (const b of this.batches) { const n = b.runCount[level]; blades += n; triangles += n * b.levels[level].userData.bladeTriangles }
      return { name, blades, triangles }
    })
  }

  dispose() {
    for (const b of this.batches) { b.levels.forEach(mesh => mesh.geometry.dispose()); b.material.dispose(); b.indexTexture.dispose() }
    this.albedoLUT.dispose(); this.noiseTex.dispose(); this.tufts.texA.dispose(); this.tufts.texB.dispose()
  }
}
