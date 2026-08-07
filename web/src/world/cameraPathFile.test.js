// The scroll camera's path file (public/scene/camera_path.glb, made by blender/scripts/camera_scroll.py): its
// contract with cameraPath.js, the path's rules, and a browser-free look for keep-out ground in view (keepOut.js).
// Pure Node: the file's JSON and keys are read directly.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { heightSampler } from './groundMesh.js'
import { KEEP_OUT, fogVisible, keepOut } from './keepOut.js'
import { swingReach } from './parallax.js'

const file = (path) => readFileSync(new URL('../../public/' + path, import.meta.url))
const meta = JSON.parse(file('data/scene_meta.json')), T = meta.terrain, water = meta.water_level
// v turned by the unit quaternion q = (x, y, z, w)
const rotate = ([x, y, z, w], v) => {
  const t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])]
  return [v[0] + w * t[0] + y * t[2] - z * t[1], v[1] + w * t[1] + z * t[0] - x * t[2], v[2] + w * t[2] + x * t[1] - y * t[0]]
}
const sub = (a, b) => a.map((v, k) => v - b[k]), length = v => Math.hypot(...v)

// The ground (as data.js samples it) and the statue (data.js: its stand from the head's matrix, the middle of the
// head 1.75 m up, 1.35 m round, 3.7 m tall, times its size), here as an upright capsule round that middle.
const raw = new Uint16Array(file(T.height_file).buffer.slice(0))
const heights = Float32Array.from(raw, v => T.height_min + (v / 65535) * (T.height_max - T.height_min))
const [x0, x1, y0, y1] = T.bounds_blender_xy, heightAt = heightSampler(heights, T.resolution, { x0, x1, y0, y1 })
const M = meta.moai.matrix, size = Math.hypot(M[0], M[1], M[2]), stand = M.slice(12, 15)
const centre = [stand[0] + .22 * size, stand[1] + 1.75 * size, stand[2] + .17 * size]
const statue = { radius: 1.35 * size, low: stand[1] + 1.35 * size, high: stand[1] + (3.7 - 1.35) * size }
const toStatueSurface = p => length(sub(p, [centre[0], Math.min(statue.high, Math.max(statue.low, p[1])), centre[2]])) - statue.radius
// How far the pointer swing and the drift can take the eye (parallax.js; CameraRig.jsx: from the distance to the
// statue's middle, at most 12 m): the highest ground or water anywhere within its sideways reach, and its drop.
const swung = p => {
  const reach = swingReach(Math.min(12, length(sub(p, centre)))), r = reach.side + reach.back
  let floor = Math.max(heightAt(p[0], p[2]), water)
  for (let k = 0; k < 8; k++) floor = Math.max(floor, heightAt(p[0] + r * Math.cos(k * Math.PI / 4), p[2] + r * Math.sin(k * Math.PI / 4)))
  return { floor, drop: reach.up }
}
// The path is a full orbit with its look-at locked on the statue, so it turns faster than the old weave in front of
// it (0.25 deg): camera_scroll.py's orbit peaks at 0.56 deg a frame, eased in and out (no jump between frames).
// It circles the statue at 5-7.5 m and keeps 3 m from its surface (3.6 m by this capsule).
const RULES = { step: .06, turnDeg: .6, clearance: .25, statue: 3 }
// The rules of one smooth flight (camera_scroll.py): an even pace of view change, (m / 0.4)^2 + (deg / 2.5)^2 +
// (change of log distance to the statue's centre / 0.02)^2 under the root, eased only at the two ends (half pace at
// the first and last frame, full from 8% in); a gentle zoom; the tiara passed close; the flight ends where it began.
const CENTRE = [1.22, 2.09, -12.03], TIARA = [1.5965, 3.5329, -13.1674]      // three.js axes (Blender x, z, -y)
const SMOOTH = { pace: 2.1, middle: 1.02, neighbour: .01, zoom: .0016, tiara: 3.95, ends: 8 / 100 }

const FILES = ['scene/camera_path.glb']

for (const name of FILES) {
  const glb = file(name)
  const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'))
  const bin = glb.subarray(28 + glb.readUInt32LE(12))
  const floats = index => {
    const a = json.accessors[index], view = json.bufferViews[a.bufferView], size = { SCALAR: 1, VEC3: 3, VEC4: 4 }[a.type]
    assert.equal(a.componentType, 5126, 'float keys'); assert.ok(!view.byteStride || view.byteStride === size * 4, 'packed keys')
    const start = (view.byteOffset ?? 0) + (a.byteOffset ?? 0)
    return new Float32Array(bin.buffer.slice(bin.byteOffset + start, bin.byteOffset + start + a.count * size * 4))
  }

  const cameraNode = json.nodes.findIndex(node => node.camera !== undefined)
  const info = json.scenes[0].extras?.scroll, frames = info?.frames
  const sampler = path => json.animations[0].samplers[json.animations[0].channels.find(c => c.target.node === cameraNode && c.target.path === path).sampler]
  const keys = path => ({ times: floats(sampler(path).input), values: floats(sampler(path).output), interpolation: sampler(path).interpolation })
  const position = keys('translation'), rotation = keys('rotation')
  const eye = i => [...position.values.subarray(i * 3, i * 3 + 3)], turn = i => [...rotation.values.subarray(i * 4, i * 4 + 4)]

  test(`${name}: the path file keeps its contract`, () => {
    const cameras = json.nodes.filter(node => node.camera !== undefined)
    assert.equal(cameras.length, 1, 'one camera node'); assert.equal(cameras[0].name, 'CAM_Scroll')
    assert.ok(json.scenes[0].nodes.includes(cameraNode), 'the camera is at the scene\'s root')
    assert.equal(json.animations.length, 1, 'one clip')
    assert.deepEqual(Object.keys(json.scenes[0].extras), ['scroll'], 'the scene\'s extras hold only the scroll')
    assert.ok(Number.isInteger(frames) && frames > 0)
    assert.ok(Number.isInteger(info.tiara?.frame) && info.tiara.frame > 0 && info.tiara.frame < frames, 'the tiara pass, in frames')
    assert.equal(info.tiara.look.length, 3)
    for (const { times, interpolation } of [position, rotation]) {
      assert.equal(interpolation, 'LINEAR')
      assert.equal(times.length, frames + 1, 'a key on every frame')
      assert.equal(times[0], 0, 'from time 0')
      const step = times[frames] / frames
      times.forEach((t, i) => assert.ok(Math.abs(t - i * step) < 1e-4 * Math.max(1, times[frames]), `key ${i} evenly spaced`))
    }
    assert.deepEqual(rotation.times, position.times)
    for (let i = 0; i <= frames; i++) assert.ok(Math.abs(length(turn(i)) - 1) < 1e-4, `unit rotation at frame ${i}`)
    const ref = meta.camera_reference
    assert.ok(length(sub(eye(0), ref.position)) < 1e-6, `frame 0 is the reference position: ${eye(0)}`)
    assert.ok(length(sub(rotate(turn(0), [0, 0, -1]), ref.forward)) < 1e-6, `frame 0 looks the reference way: ${rotate(turn(0), [0, 0, -1])}`)
    assert.ok(length(sub(rotate(turn(0), [0, 1, 0]), ref.up)) < 1e-6, `frame 0 has the reference up: ${rotate(turn(0), [0, 1, 0])}`)
    const fov = json.cameras[json.nodes[cameraNode].camera].perspective.yfov * 180 / Math.PI
    // (1e-5: Blender keeps the lens in single precision, which is 1.6e-6 degrees here)
    assert.ok(Math.abs(fov - ref.vertical_fov_deg) < 1e-5, `field of view ${fov} degrees`)
  })

  test(`${name}: the path moves smoothly and keeps clear of the ground, the water and the statue`, t => {
    const failures = { step: [], turn: [], ground: [], statue: [] }
    for (let i = 0; i <= frames; i++) {
      const p = eye(i)
      if (i) {
        const moved = length(sub(p, eye(i - 1)))
        const a = turn(i), b = turn(i - 1), dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])
        const turned = 2 * Math.acos(Math.min(1, dot)) * 180 / Math.PI
        if (moved > RULES.step) failures.step.push(`${i}: ${moved.toFixed(3)} m`)
        if (turned > RULES.turnDeg) failures.turn.push(`${i}: ${turned.toFixed(3)} deg`)
      }
      const { floor, drop } = swung(p), above = p[1] - floor - drop
      if (above < RULES.clearance) failures.ground.push(`${i}: ${above.toFixed(3)} m above, swing taken off`)
      const near = toStatueSurface(p)
      if (near < RULES.statue) failures.statue.push(`${i}: ${near.toFixed(3)} m`)
    }
    const report = Object.entries(failures).filter(([, list]) => list.length)
      .map(([rule, list]) => `${rule}: ${list.length} frames, e.g. ${list.slice(0, 4).join('; ')}${list.length > 4 ? ' ... ' + list.at(-1) : ''}`)
    for (const line of report) t.diagnostic(line)
    assert.deepEqual(report, [], 'rules: step <= 6 cm and turn <= 0.6 deg per frame; eye >= 0.25 m + swing above the ground and water within its reach; >= 3 m from the statue')
  })

  test(`${name}: one smooth flight: an even pace, a gentle zoom, close past the tiara, back where it began`, t => {
    const forward = i => rotate(turn(i), [0, 0, -1]), dist = i => length(sub(eye(i), CENTRE))
    const pace = []
    for (let i = 1; i <= frames; i++) {
      const a = forward(i), b = forward(i - 1), c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
      const deg = Math.atan2(length(c), a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) * 180 / Math.PI     // (acos is noisy near 0)
      const zoom = Math.abs(Math.log(dist(i) / dist(i - 1)))
      pace.push({ value: Math.hypot(length(sub(eye(i), eye(i - 1))) / .4, deg / 2.5, zoom / .02), zoom })
    }
    const values = pace.map(p => p.value), mean = values.reduce((a, b) => a + b) / values.length
    const cut = Math.floor(SMOOTH.ends * frames), middle = values.slice(cut, -cut)
    const ratio = list => Math.max(...list) / Math.min(...list)
    const neighbour = Math.max(...values.slice(1).map((v, i) => Math.abs(v - values[i]))) / mean
    const zoom = Math.max(...pace.map(p => p.zoom))
    let tiara = Infinity, at = 0
    for (let i = 0; i <= frames; i++) { const d = length(sub(eye(i), TIARA)); if (d < tiara) { tiara = d; at = i } }
    const a = forward(0), b = forward(frames), endTurn = Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])) * 180 / Math.PI
    t.diagnostic(`pace max/min ${ratio(values).toFixed(3)} (middle ${ratio(middle).toFixed(4)}), neighbour change ${(neighbour * 100).toFixed(2)}% of the mean, zoom ${(zoom * 100).toFixed(3)}% a frame, tiara ${tiara.toFixed(2)} m at frame ${at}`)
    assert.ok(ratio(values) <= SMOOTH.pace, `fastest / slowest pace ${ratio(values)}`)
    assert.ok(ratio(middle) <= SMOOTH.middle, `fastest / slowest pace between the eased ends ${ratio(middle)}`)
    assert.ok(neighbour <= SMOOTH.neighbour, `pace change between neighbouring frames ${neighbour * 100}% of the mean`)
    assert.ok(zoom <= SMOOTH.zoom, `zoom ${zoom * 100}% a frame`)
    assert.ok(tiara <= SMOOTH.tiara, `nearest the tiara ${tiara} m`)
    assert.ok(Math.abs(at - info.tiara.frame) <= 2, `the tiara pass at frame ${at}, the file says ${info.tiara.frame}`)
    assert.ok(length(sub(eye(frames), eye(0))) < 1e-3 && endTurn < .01, `the last pose is the first: ${length(sub(eye(frames), eye(0)))} m, ${endTurn} deg`)
  })

  // View rays marched over the height map (as pointerGround.js does) on a 21:9 frame, the widest window shape: what
  // ground each one meets first, and whether it is keep-out. Trees, grass, plants and rocks are not in the height map,
  // so this over-reports: it is printed as information (scripts/check-path-guard.mjs is the judge). It asserts only
  // what the ground itself must hide: the void beyond the terrain's south edge, close by (the orbit looks south from
  // behind the statue; the south ridge in the height map is what hides that edge, trees only add to it).
  test(`${name}: keep-out ground in view, from the height map (information)`, t => {
    const fovY = json.cameras[json.nodes[cameraNode].camera].perspective.yfov, tanY = Math.tan(fovY / 2), tanX = tanY * 21 / 9
    const columns = 42, rows = 18, samples = 60, below = T.height_min - .25, near = 40
    const shares = [], southVoid = []
    for (let s = 0; s <= samples; s++) {
      const i = Math.round(s / samples * frames), o = eye(i), q = turn(i)
      let weight = 0
      for (let r = 0; r < rows; r++) for (let c = 0; c < columns; c++) {
        const d = rotate(q, [((c + .5) / columns * 2 - 1) * tanX, (1 - (r + .5) / rows * 2) * tanY, -1]), l = length(d)
        const dir = d.map(v => v / l), at = u => o.map((v, k) => v + dir[k] * u)
        const surface = (x, z) => Math.max(heightAt(x, z), water)
        for (let previous = 0, u = .25, step = .25; u < 140; previous = u, step *= 1.1, u += step) {
          const p = at(u)
          if (p[0] < x0 || p[0] > x1 || -p[2] < y0 || -p[2] > y1) {          // past the terrain's edge
            if (dir[1] < 0) {
              const hit = (below - o[1]) / dir[1], v = at(hit)
              weight += fogVisible(hit, (o[1] + below) / 2)
              if (-v[2] < y0 && hit < near) southVoid.push(`frame ${i}: ${hit.toFixed(1)} m`)
            }
            break
          }
          if (p[1] > surface(p[0], p[2])) continue
          let a = previous, b = u
          for (let k = 0; k < 8; k++) { const m = (a + b) / 2, v = at(m); if (v[1] > surface(v[0], v[2])) a = m; else b = m }
          const hit = at(b)
          if (keepOut(hit[0], hit[2], heightAt(hit[0], hit[2]), water)) weight += fogVisible(b, (o[1] + hit[1]) / 2)
          break
        }
      }
      shares.push([i, weight / (columns * rows)])
    }
    // As the browser check judges: against the opening view (the approved look) plus 0.2 points, at least 0.2%.
    const limit = Math.max(.002, shares[0][1] + .002), over = shares.filter(([, share]) => share > limit)
    t.diagnostic(`keep-out ground in view (fog-weighted share of a 21:9 frame, trees ignored): opening view ${(shares[0][1] * 100).toFixed(1)}%; ${over.length} of ${shares.length} sampled frames over ${(limit * 100).toFixed(1)}%`)
    for (const [i, share] of over) t.diagnostic(`  frame ${i} (progress ${(i / frames).toFixed(3)}): ${(share * 100).toFixed(1)}%`)
    assert.deepEqual([...new Set(southVoid)], [], `no view of the void past the south edge (y = ${KEEP_OUT.terrain.y0}) within ${near} m`)
  })
}
