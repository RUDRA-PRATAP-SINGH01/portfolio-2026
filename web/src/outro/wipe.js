import * as THREE from 'three/webgpu'
import { abs, clamp, cos, float, fract, length, max, mix, positionGeometry, pow, round, select, smoothstep, step, texture, uniform, varying, vec2, vec3, vec4 } from 'three/tsl'
import { HEAD_OUTLINE } from './headOutline.js'
import { outro, wipeProgress } from './timeline.js'

// The light screen that rises over the scene after the camera's path (timeline.js), rebuilt from alche.studio's
// (studied 2026-11-18, nothing copied). It is drawn straight onto the canvas over the finished frame (Post.jsx).
// Its edge follows the scroll through alche's spring: on a fast scroll it lags, bows down in the middle and
// softens; at rest it is a 1 px line. On the light, a faint grid and rows of crosses climb with the scroll, and
// the stone head's outline stays in white where the head was. Once the light covers the window, the scene is not
// drawn at all (Post.jsx): only this pass is.
export const WIPE = Object.freeze({
  // alche springs once a frame, so its bow depends on the screen's rate: their film (bow ~25 px at 1650 px/s) was
  // drawn at ~130 Hz. Fixed 1/120 s steps give that edge at any rate; their followers are per second, so unchanged.
  step: 1 / 120,
  follow: 10 * 1.5 / 120,      // the edge's goal follows the wipe progress (alche's follower at m 1.5, per step)
  scroll: 10 * .5 / 120,       // the grid follows the scroll (m .5)
  covered: .99,                // V at or above which the light covers the window
  shown: .01,                  // V at or below which nothing is drawn
  light: [224.69, 235.05, 236.32],   // display RGB at the centre of alche's covered frames
  vignette: [.3, 1.5],         // fitted to their corners (166, 174, 175): darker from .3 to 1.5 screen-uv out
  grid: 64, gridShade: .02, gridRise: 1.5,       // cells across the window's longer side; 2% darker lines; climb rate
  crosses: 8, crossShade: .2, crossRise: .1, crossSize: .15,   // a cross every 1/8 of that side; 20%; size of a cell
})

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }

/** How much narrower than 16:9 the window is (0 at 16:9 or wider, 1 at 9:16 or narrower): the bow is smaller on a phone. */
export const spWeight = aspect => Math.min(1, Math.max(0, (16 / 9 - aspect) / (16 / 9 - 9 / 16)))

/** One fixed step of the edge: v follows the goal, V follows v through the spring's B (V never overshoots).
 *  At rest it is put exactly on the goal, so the page knows it has stopped. */
export function springStep(state, goal) {
  state.v += (goal - state.v) * WIPE.follow
  const M = state.v - state.V, A = M - state.B
  state.B += .5 * A
  state.V += .5 * M
  if (Math.abs(goal - state.v) < 1e-6 && Math.abs(state.v - state.V) < 1e-6 && Math.abs(state.B) < 1e-6) { state.v = state.V = goal; state.B = 0 }
  return state
}

/** How much light covers the point (x, y) of the window (0..1, y up from the bottom), as the shader works it out:
 *  edge V, spring B, `height` the drawing buffer's height in pixels, `aspect` its width / height. */
export function selector(x, y, V, B, height, aspect) {
  if (V <= WIPE.shown) return 0
  const range = 1 / height + Math.abs(B) * .2
  const bend = -Math.cos((x - .5) * Math.PI) * B * (1 - .8 * spWeight(aspect))
  return smooth(0, range, -y + V * (B > 0 ? 1 + range : 1) + bend)
}

/** Whether the light fills the window: the middle of its edge, at its lowest point, is past the top row. Only then
 *  is the scene left out (Post.jsx), a little after outro.covered (V .99), so the last rows at the top never pop. */
export function filled(V, B, height, aspect) {
  const range = 1 / height + Math.abs(B) * .2
  const low = V * (B > 0 ? 1 + range : 1) + Math.min(0, -B) * (1 - .8 * spWeight(aspect)) - range / 2
  return V >= WIPE.covered && low >= 1 - 1 / height
}

/** The highest point (0..1 up the window) the light can reach this frame: the pass draws nothing above it. */
export function edgeTop(V, B, height, aspect) {
  if (V >= WIPE.covered) return 1
  const range = 1 / height + Math.abs(B) * .2
  return Math.min(1, V * (B > 0 ? 1 + range : 1) + Math.max(0, -B) * (1 - .8 * spWeight(aspect)) + 2 / height)
}

/** The outline's paths in the 1600 x 900 frame, and their bounds there, padded by a stroke and 2 px. */
function outlineShape() {
  const F = HEAD_OUTLINE, paths = F.paths.map(d => new Path2D(d))
  const draw = (context, stroke = F.stroke) => {
    context.lineWidth = stroke; context.lineJoin = 'round'; context.lineCap = 'round'; context.strokeStyle = '#fff'
    for (const path of paths) context.stroke(path)
  }
  // The bounds are read off the paths drawn at half size (any path syntax, curves included).
  const w = F.width / 2, h = F.height / 2, canvas = document.createElement('canvas')
  canvas.width = w; canvas.height = h
  const context = canvas.getContext('2d', { willReadFrequently: true })
  context.setTransform(.5, 0, 0, .5, 0, 0); draw(context)
  const { data } = context.getImageData(0, 0, w, h)
  let x0 = w, y0 = h, x1 = 0, y1 = 0
  for (let i = 3; i < data.length; i += 4) if (data[i]) {
    const n = (i - 3) / 4, x = n % w, y = (n - x) / w
    x0 = Math.min(x0, x); x1 = Math.max(x1, x + 1); y0 = Math.min(y0, y); y1 = Math.max(y1, y + 1)
  }
  const pad = F.stroke + 2
  return { draw, bounds: [x0 * 2 - pad, y0 * 2 - pad, x1 * 2 + pad, y1 * 2 + pad] }
}

/** The pass. frame(dt) once a frame (Post.jsx) moves the edge, writes outro.wipe (V) and outro.covered, and says
 *  whether the light fills the window; draw(renderer) puts it on the canvas over the finished frame. */
export function createWipe(renderer) {
  const canvas = renderer.domElement, reduced = matchMedia('(prefers-reduced-motion: reduce)')
  const shape = outlineShape()
  const u = {
    V: uniform(0), B: uniform(0), cover: uniform(0), top: uniform(-1), sp: uniform(0),
    res: uniform(new THREE.Vector2(1, 1)),        // drawing buffer, pixels
    side: uniform(1), cross: uniform(1),          // the window's longer side; a cross's size (pixels)
    lines: uniform(0), rows: uniform(0),          // how far the grid's lines and the crosses' rows have climbed
    box: uniform(new THREE.Vector4(0, 0, 1, 1)),  // the outline's texture on the window: x, y (from the top), w, h
  }
  // The quad covers the window up to the light's highest point only: below it, every pixel is shaded.
  const clipY = mix(float(-1), u.top, positionGeometry.y.mul(.5).add(.5))
  const q = varying(vec2(positionGeometry.x, clipY).mul(.5).add(.5))       // window uv, y up
  const p = q.mul(u.res)
  const range = float(1).div(u.res.y).add(abs(u.B).mul(.2))
  const bend = cos(q.x.sub(.5).mul(Math.PI)).negate().mul(u.B).mul(float(1).sub(u.sp.mul(.8)))
  const rise = u.V.mul(select(u.B.greaterThan(0), range.add(1), float(1)))
  const sel = max(u.cover, smoothstep(0, range, rise.sub(q.y).add(bend)))
  // The light, in display values (the canvas takes them as they are), darkening toward the corners.
  const light = vec3(...WIPE.light.map(c => c / 255)).mul(float(1).sub(smoothstep(...WIPE.vignette, length(q.sub(.5)))))
  // The grid and the crosses lie on a square of the window's longer side, centred (g: 0..1 across it, y up).
  const g = p.sub(u.res.mul(.5)).div(u.side).add(.5)
  const cell = abs(fract(g.mul(WIPE.grid).sub(vec2(0, u.lines))).sub(.5))
  const line = max(smoothstep(.45, .5, cell.x), smoothstep(.45, .5, cell.y))
  const n = WIPE.crosses, column = clamp(round(g.x.mul(n)), 0, n).div(n)
  const k = round(g.y.sub(u.rows).mul(n)), row = u.rows.add(k.div(n))   // the nearest row (rows climb, from phase)
  const at = abs(g.sub(vec2(column, row)).mul(u.side).div(u.cross))
  const inside = step(at.x, .5).mul(step(at.y, .5)).mul(step(0, row)).mul(float(1).sub(step(1, row)))
  const mark = max(float(1).sub(smoothstep(.01, .08, at.x)), float(1).sub(smoothstep(.008, .08, at.y))).mul(inside)
  // alche's rows wrap round at both ends, so their first row is drawn twice (twice as dark).
  const shade = pow(float(1).sub(mark.mul(WIPE.crossShade)), float(2).sub(step(.5, abs(k))))
  // The outline: a hard white line (alche's has no smoothing), read from its texture at this pixel.
  const outline = texture(new THREE.Texture(), vec2(p.x, u.res.y.sub(p.y)).sub(u.box.xy).div(u.box.zw))
  const color = mix(light.mul(float(1).sub(line.mul(WIPE.gridShade))).mul(shade), vec3(1), step(.5, outline.a))
  const material = new THREE.NodeMaterial()
  material.name = 'OutroWipe'
  material.vertexNode = vec4(positionGeometry.x, clipY, 0, 1)
  material.fragmentNode = vec4(color, sel)
  material.transparent = true; material.depthTest = false; material.depthWrite = false; material.fog = false
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material)
  mesh.frustumCulled = false
  const scene = new THREE.Scene(), camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  scene.add(mesh)

  // The outline drawn at the window's size into a texture just large enough for it: the 1600 x 900 frame scaled
  // to the window's height and centred (headOutline.js), so its line is the frame's stroke scaled the same way.
  let size = ''
  const fit = (W, H) => {
    const k = H / HEAD_OUTLINE.height, left = (W - HEAD_OUTLINE.width * k) / 2, [b0, b1, b2, b3] = shape.bounds
    const x = Math.floor(left + b0 * k), y = Math.floor(b1 * k)
    const w = Math.max(1, Math.ceil(left + b2 * k) - x), h = Math.max(1, Math.ceil(b3 * k) - y)
    const image = document.createElement('canvas')
    image.width = w; image.height = h
    const context = image.getContext('2d')
    // A phone's line is 2 CSS px (alche's is 3-4 device px there); the frame's 3 px scale with the window elsewhere.
    context.setTransform(k, 0, 0, k, left - x, -y); shape.draw(context, Math.min(innerWidth, innerHeight) < 600 ? 2 * H / innerHeight / k : undefined)
    const map = new THREE.CanvasTexture(image)
    map.flipY = false; map.colorSpace = THREE.NoColorSpace; map.generateMipmaps = false
    map.minFilter = map.magFilter = THREE.NearestFilter
    outline.value.dispose(); outline.value = map
    u.box.value.set(x, y, w, h)
    u.res.value.set(W, H); u.side.value = Math.max(W, H); u.cross.value = WIPE.crossSize * Math.min(W, H) / WIPE.crosses
    u.sp.value = spWeight(W / H)
  }

  // The fixed steps (WIPE.step) and the state drawn: between the last two steps, by the time left over.
  const start = wipeProgress(outro.eased)
  const now = { v: start, V: start, B: 0, s: outro.eased }, before = { ...now }
  let left = 0, warmed = false, shown = false, under = false
  // Where the pointer is (window CSS px), for the ring's colour over the light (outro.css, data-outro-under).
  const pointer = { x: -1, y: -1 }, track = e => { pointer.x = e.clientX; pointer.y = e.clientY }
  addEventListener('pointermove', track, { passive: true })
  return {
    frame(dt) {
      const W = canvas.width, H = canvas.height
      if (`${W}x${H}` !== size) { size = `${W}x${H}`; fit(W, H) }
      const goal = wipeProgress(outro.eased)
      // Reduced motion: the edge is where the scroll is, with no spring and no bend.
      if (reduced.matches) { Object.assign(now, { v: goal, V: goal, B: 0, s: outro.eased }); Object.assign(before, now); left = 0 }
      else {
        left += Math.min(.1, Math.max(0, dt))
        while (left >= WIPE.step) {
          Object.assign(before, now)
          springStep(now, goal)
          now.s += (outro.eased - now.s) * WIPE.scroll
          if (Math.abs(outro.eased - now.s) < 1e-6) now.s = outro.eased
          left -= WIPE.step
        }
      }
      const t = left / WIPE.step, V = before.V + (now.V - before.V) * t, B = before.B + (now.B - before.B) * t
      const s = before.s + (now.s - before.s) * t
      outro.wipe = V; outro.covered = V >= WIPE.covered
      shown = V > WIPE.shown
      const over = shown && pointer.x >= 0 && selector(pointer.x / innerWidth, 1 - pointer.y / innerHeight, V, B, H, W / H) > .5
      if (over !== under) { under = over; document.documentElement.toggleAttribute('data-outro-under', over) }
      // Not shown, it is drawn (once, to warm it up) with the edge at the bottom: a 2 px quad of nothing.
      const full = filled(V, B, H, W / H)
      u.V.value = shown ? V : 0; u.B.value = shown ? B : 0; u.cover.value = full ? 1 : 0
      u.top.value = edgeTop(u.V.value, u.B.value, H, W / H) * 2 - 1
      // alche's grid climbs with the whole page's scroll (in windows): their path's end is 7300 px of a 900 px window.
      const S = s + 7300 / 900
      u.lines.value = S * WIPE.gridRise; u.rows.value = S * WIPE.crossRise % 1
      return full
    },
    /** Over the finished frame, straight onto the canvas (as glassName.js draws: no colour conversion, the canvas's
     *  colour kept, its depth cleared). The first frame it is not shown, it is drawn once so its shaders are ready. */
    draw(r) {
      if (!shown && warmed) return
      const saved = [r.outputColorSpace, r.toneMapping, r.autoClear, r.autoClearColor, r.autoClearDepth, r.autoClearStencil]
      r.outputColorSpace = THREE.ColorManagement.workingColorSpace; r.toneMapping = THREE.NoToneMapping
      r.autoClear = true; r.autoClearColor = false; r.autoClearDepth = true; r.autoClearStencil = false
      try { r.render(scene, camera) } finally {
        [r.outputColorSpace, r.toneMapping, r.autoClear, r.autoClearColor, r.autoClearDepth, r.autoClearStencil] = saved
      }
      warmed = true
    },
    dispose() {
      mesh.geometry.dispose(); material.dispose(); outline.value.dispose()
      removeEventListener('pointermove', track); document.documentElement.removeAttribute('data-outro-under')
    },
  }
}
