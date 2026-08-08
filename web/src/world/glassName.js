import * as THREE from 'three/webgpu'
import { GLASS, glassRestA, glassRestPlaneXY, glassRestStretch, glassTitleGeometry, glassTitleMaterial, glassVertex } from './glassTitle.js'
import { base } from './parallax.js'
import { scroll } from './scroll.js'

// The name on the opening view, drawn with Active Theory's sliced-glass title shader (glassTitle.js).
// Their approach: a title hangs in the world in front of where the camera rests; the camera's own movement carries
// it across the view, and the shader breaks it into strips the further it is from where it rests. Here the camera
// is the scroll camera: the name hangs NAME.depth metres in front of the opening view, on the line of sight to
// where the page lays the name out (the h1 in App.jsx, hatom.com's place and size, loading.css). At rest the
// texture lands on those pixels (see the last point below); as the visitor scrolls, the orbit carries the name off
// to the left and it breaks up, and when the orbit comes back round it slides in broken and settles clean.
// What differs from theirs, and why (their scene, read from their files: eye 5.8 units from a card, 35 degree view,
// cards 50 degrees apart on a ring; a title is clean while its view-space x is within -1.4 .. .4):
//   - Their title rests in the middle of the view; this one rests on the left. So the shader's "middle of the view"
//     (its reference) is put on the name: their clean band is centred on it at rest.
//   - Their titles cross about 3 units to the edge of the view and break up on the way. This name rests near the
//     left edge and the orbit takes it off that way, about 1.5 of their units (at its letters' scale) away. Read at
//     their scale it would leave the view still clean, so the shader's position input runs NAME.travel times
//     faster than the letters' scale (its `unit` is the plane's metres per unit / travel): the name is as broken
//     when it reaches the edge as theirs are when they reach theirs. The texture is laid out by their size rule
//     (the title's font from its length, in a 1024 texture), enlarged by the square root of the change in the
//     shader's slide stretch, so a strip stays as wide against the letters as in their scene.
//   - Their fade works on the distance from the camera's rig (3.8 at rest, gone between 5 and 6); it is given the
//     distance in the same proportion (3.8 x distance / distance at rest). Their camera never comes nearer than at
//     rest; this orbit passes through the name on its way back, so it also fades out when nearer than at rest, by
//     the mirror image of their fade (NAME.near).
//   - The texture is drawn so that the shader's own slight stretch and tilt at rest come out level and true: the
//     name at rest is the page's name. Their shader is not changed. (One trace of the faster position input: the
//     widest line is a little wider than their clean band, so the outer sixth of it already sits at the very start
//     of the strips, edges up to 3e-3: the first letter of a line and the end of PRATAP land up to about a pixel
//     off at a 47 px font. glassTitle.test.js holds that bound. Hovering makes it all clean.)
// The h1 stays in the page for screen readers and search engines; its letters are made transparent once this
// draws (data-glass on .name-block). ?glass=0 shows the page's own letters instead.
export const NAME = Object.freeze({
  depth: 7.5,                    // metres in front of the opening camera: where the pointer's sway turns (parallax.js), so it does not slide the name
  cleanLeft: null,               // null: their clean band (vViewDir.x within .5 +- .9) centred on the name at rest
  travel: 1.9,                   // their units per unit of the letters' scale, for the shader's position input (see above)
  near: [GLASS.rest ** 2 / GLASS.fade[0], GLASS.rest ** 2 / GLASS.fade[1]],   // 2.89 .. 2.41: fades in from 2.41 to 2.89
  // The name belongs to the beginning only: the path ends on the opening pose again, so past half of it the name
  // fades out (and back in on the way back) over these seconds, whatever the distance fades say.
  gate: { until: .5, seconds: .9 },
})

/** The beginning-only gate: `gate` (0..1) moved toward 1 before NAME.gate.until of the path, toward 0 after it. */
export const nameGate = (gate, progress, dt) =>
  Math.min(1, Math.max(0, gate + (progress < NAME.gate.until ? 1 : -1) * Math.max(0, dt) / NAME.gate.seconds))

const query = new URLSearchParams(globalThis.location?.search ?? '')
export const GLASS_NAME = query.get('name') !== '0' && query.get('glass') !== '0'

const easeOutQuint = t => 1 - (1 - t) ** 5
const unitScale = new THREE.Vector3(1, 1, 1)
const crange = (v, a, b, c, d) => Math.min(Math.max(c, d), Math.max(Math.min(c, d), c + (v - a) * (d - c) / (b - a)))

/** Their size rule for a title (WorkPaneUI): 0.9 x range(length, 5, 20, 130, 100), clamped. */
export const titleFont = length => .9 * crange(length, 5, 20, 130, 100)

/** Where the name's texture goes, in the resting camera's view space. All in plain numbers, so it can be tested.
 *  view  { width, height, fovY (degrees) }         the canvas in CSS px and the camera's vertical field of view
 *  dom   { fontSize, lines: [{ x, baseline }], centre: [x, y], inkLeft }   the page's name in CSS px
 *  Returns { s (metres per their unit), centre [x, y, z] of the plane, A (vViewDir.x at its middle), reference,
 *  T [a, b, c, d] (page px -> texture px about the centres), texCentre [px, py], project (texture px -> screen px) }. */
export function layoutName(view, dom, { depth = NAME.depth, cleanLeft = NAME.cleanLeft, k = NAME.travel, font = titleFont(18), size = GLASS.textureSize } = {}) {
  const tanY = Math.tan(THREE.MathUtils.degToRad(view.fovY) / 2), tanX = tanY * view.width / view.height
  // With the shader's unit k times smaller than the plane's, its picture lies k times faster across the plane (the
  // slide term), so a strip covers more of the picture: the name is drawn as much larger in the texture, and a
  // strip stays as wide against the letters as in their scene.
  font *= Math.sqrt(glassRestStretch(1) / glassRestStretch(k))
  const [p0x, p0y] = dom.centre, t0 = [size / 2, size / 2], f = font / dom.fontSize
  let s = .19 * depth, xc = 0, yc = 0, T = [f, 0, 0, f], A = 0
  // texture px -> screen px at rest for the current guess
  const project = (px, py) => {
    const [X, Y] = glassRestPlaneXY(px / size, 1 - py / size, A, k), [lx, ly, lz] = glassVertex(X, Y)
    const x = xc + GLASS.plane[0] * s * lx, y = yc + GLASS.plane[1] * s * ly, z = -depth + s * lz
    return [(x / -z / tanX + 1) / 2 * view.width, (1 - y / -z / tanY) / 2 * view.height, -z]
  }
  // first guess for the centre: on the line of sight to the page's name
  xc = ((p0x / view.width) * 2 - 1) * tanX * depth; yc = (1 - (p0y / view.height) * 2) * tanY * depth
  for (let i = 0; i < 12; i++) {
    // vViewDir.x = cleanLeft at the name's left edge, or (cleanLeft null) .5 at its middle: the clean band centred on it
    A = cleanLeft === null ? glassRestA(.5, .5, k) : glassRestA((t0[0] + T[0] * (dom.inkLeft - p0x)) / size, cleanLeft, k)
    // where the texture's centre lands, and the screen's response to a texture pixel there
    const h = .5, c = project(...t0), ex = project(t0[0] + h, t0[1]), ey = project(t0[0], t0[1] + h)
    const J = [(ex[0] - c[0]) / h, (ey[0] - c[0]) / h, (ex[1] - c[1]) / h, (ey[1] - c[1]) / h]   // [dsx/dpx, dsx/dpy, dsy/dpx, dsy/dpy]
    const det = J[0] * J[3] - J[1] * J[2], lambda = Math.sqrt(Math.abs(det))
    // T = f x (J / lambda)^-1: drawn this way the texture comes out level, true and at the page's size
    T = [J[3] / lambda * f, -J[1] / lambda * f, -J[2] / lambda * f, J[0] / lambda * f].map(v => v * lambda * lambda / det)
    s *= 1 / (f * lambda)                          // page px per screen px must be 1
    const D = c[2], again = project(...t0)
    xc += (p0x - again[0]) / view.width * 2 * tanX * D
    yc -= (p0y - again[1]) / view.height * 2 * tanY * D
  }
  const unit = s / k, reference = xc + A * unit
  // The plane is bowed (their bulge), less at its sides, so one straight transform is out by a pixel or two at the
  // ends of a line. place() finds the texture point (and the transform there) for any page point exactly.
  const jacobian = (px, py) => {
    const h = .5, c = project(px, py), ex = project(px + h, py), ey = project(px, py + h)
    return { at: c, J: [(ex[0] - c[0]) / h, (ey[0] - c[0]) / h, (ex[1] - c[1]) / h, (ey[1] - c[1]) / h] }
  }
  const place = (x, y) => {
    let [px, py] = [t0[0] + T[0] * (x - p0x) + T[1] * (y - p0y), t0[1] + T[2] * (x - p0x) + T[3] * (y - p0y)], J
    for (let i = 0; i < 6; i++) {
      const q = jacobian(px, py), ex = x - q.at[0], ey = y - q.at[1]; J = q.J
      const det = J[0] * J[3] - J[1] * J[2]
      px += (J[3] * ex - J[1] * ey) / det; py += (-J[2] * ex + J[0] * ey) / det
    }
    const det = J[0] * J[3] - J[1] * J[2]
    return { at: [px, py], T: [J[3] / det, -J[1] / det, -J[2] / det, J[0] / det] }   // page px -> texture px there
  }
  return { s, unit, k, font, centre: [xc, yc, -depth], A, reference, T, texCentre: t0, project, place, restDistance: Math.hypot(xc, yc, depth) }
}

/** The page's name, measured: font size, each line's origin and baseline, the centre of its ink. */
let measuring = null
function measureDom(h1, canvasBox) {
  const style = getComputedStyle(h1), fontSize = parseFloat(style.fontSize)
  const font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
  const ctx = measuring ??= document.createElement('canvas').getContext('2d'); ctx.font = font
  const ascent = ctx.measureText('H').fontBoundingBoxAscent, cap = ctx.measureText('H').actualBoundingBoxAscent
  const lines = [...h1.querySelectorAll('span')].map(span => {
    const range = document.createRange(); range.selectNodeContents(span)
    const r = range.getBoundingClientRect(), text = span.textContent.trim().toUpperCase(), m = ctx.measureText(text)
    const x = r.left - canvasBox.left, baseline = r.top - canvasBox.top + ascent
    return { text, x, baseline, inkLeft: x - m.actualBoundingBoxLeft, inkRight: x + m.actualBoundingBoxRight }
  }).filter(line => line.text)
  if (!lines.length) return null
  const inkLeft = Math.min(...lines.map(l => l.inkLeft)), inkRight = Math.max(...lines.map(l => l.inkRight))
  const top = lines[0].baseline - cap, bottom = lines.at(-1).baseline
  return { font, fontSize, lines, inkLeft, inkRight, top, bottom, centre: [(inkLeft + inkRight) / 2, (top + bottom) / 2],
    text: lines.map(l => l.text).join(' ') }
}

// The plane's columns, as its geometry has them: each is flat (the bend depends on u only), so it faces the camera
// exactly when the camera is in front of its plane. [x, z, normal x, normal z] in the mesh's own units (no hover).
const COLUMNS = Array.from({ length: GLASS.segments[0] }, (_, i) => {
  const n = GLASS.segments[0], [x0, , z0] = glassVertex(i / n, .5), [x1, , z1] = glassVertex((i + 1) / n, .5)
  return [x0, z0, z0 - z1, x1 - x0]
})
// Their title's colour in the texture: white text through their text shader, which tints it 0-20% towards
// (.5, .5, 1) as it shimmers and draws it at 90% (DefaultText.glsl): (.81-.90, .81-.90, .90); here its middle.
const INK = [218 / 255, 218 / 255, 230 / 255]

/** The name, ready to draw over the finished frame. canvas: the renderer's; sceneDepth: the scene pass's depth
 *  texture (occlusion). */
export function createGlassName({ world, camera, canvas, sceneDepth }) {
  const block = document.querySelector('.name-block'), h1 = block?.querySelector('.name')
  if (!h1 || !canvas) return null
  // The texture: only the lettering's coverage, one channel (the shader gives it INK). The page's copy of it is let
  // go once it is on the graphics chip, and drawn again at full size when the name is laid out again.
  const size = GLASS.textureSize, sheet = document.createElement('canvas')
  sheet.width = sheet.height = size
  const map = new THREE.CanvasTexture(sheet)
  map.format = THREE.RedFormat; map.colorSpace = THREE.NoColorSpace
  map.minFilter = THREE.LinearMipmapLinearFilter; map.magFilter = THREE.LinearFilter; map.generateMipmaps = true
  map.onUpdate = () => { sheet.width = sheet.height = 1 }
  // (only its front: from behind the statue the orbit would otherwise show the name back to front)
  const { material, uniforms } = glassTitleMaterial(map, { sceneDepth, side: THREE.FrontSide, ink: INK })
  const mesh = new THREE.Mesh(glassTitleGeometry(), material)
  mesh.name = 'GlassName'
  // Never culled by three: behind the loading screen it is drawn once at a speck's size to build its shaders, and
  // the camera may be anywhere then. Whether it is seen at all is decided here, more closely (frame()).
  mesh.frustumCulled = false
  const scene = new THREE.Scene()
  scene.add(mesh)
  const reduced = matchMedia('(prefers-reduced-motion: reduce)')
  const state = { fonts: false, dirty: true, key: '', layout: null, anchor: new THREE.Vector3(), base: new THREE.Vector3(), corners: [],
    entry: null, gate: null, hovered: false, pointer: null, box: null, warmed: false, drawn: false, fov: 0, aspect: 0 }
  const mark = () => { state.dirty = true }
  document.fonts.ready.then(() => document.fonts.load(`700 50px "Pathway Name"`)).then(() => { state.fonts = true; mark() }, () => { state.fonts = true; mark() })
  // The page is measured again only when something can have moved it: a new window size, the font, the canvas
  // (three sizes it a frame or more after the window's resize event; the camera's aspect changes with it).
  const resized = new ResizeObserver(mark)
  resized.observe(h1); resized.observe(canvas)
  addEventListener('resize', mark)

  // The resting camera: the scroll path's first pose (the Blender reference camera), without the pointer sway.
  const restPosition = new THREE.Vector3(), restTurn = new THREE.Quaternion()
  const restPose = () => {
    if (world.cameraPath) { world.cameraPath.poseAt(0, restPosition, restTurn); return }
    const r = world.meta.camera_reference, target = new THREE.Vector3(...r.forward).multiplyScalar(12).add(restPosition.fromArray(r.position))
    restTurn.setFromRotationMatrix(new THREE.Matrix4().lookAt(restPosition, target, new THREE.Vector3(0, 1, 0)))
  }

  const lay = () => {
    if (!state.dirty && state.fov === camera.fov && state.aspect === camera.aspect) return !!state.layout
    // The canvas's layout size and place (not its on-screen box: the reveal scales its shell for a while). It fills
    // the window from its corner, as the page's name is laid out; the pointer is tested in the same box.
    const width = canvas.offsetWidth, height = canvas.offsetHeight
    const dom = measureDom(h1, { left: 0, top: 0 })
    if (!dom || !width || !height) return false
    state.dirty = false; state.fov = camera.fov; state.aspect = camera.aspect
    state.box = { left: 0, top: 0, width, height }
    const key = `${width}x${height}|${dom.fontSize}|${dom.lines.map(l => `${l.text}@${l.x.toFixed(2)},${l.baseline.toFixed(2)}`).join(';')}|${camera.fov}`
    if (key === state.key && state.layout) return true
    const layout = layoutName({ width, height, fovY: camera.fov }, dom, { font: titleFont(dom.text.length) })
    if (![layout.s, layout.unit, layout.reference, ...layout.centre, ...layout.T].every(Number.isFinite)) return false
    state.key = key
    // The texture: the page's name, each letter drawn where the shader's rest transform takes it back onto that
    // letter on the page, through the inverse of that transform there (level, true, at the page's size).
    sheet.width = sheet.height = size                       // (back to full size, cleared; let go after each upload)
    const ctx = sheet.getContext('2d'), [a, b, c, d] = layout.T, [t0x, t0y] = layout.texCentre, [p0x, p0y] = dom.centre
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, size, size)
    // white: coverage only, the colour is INK in the shader
    ctx.font = dom.font; ctx.fontKerning = 'normal'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = '#fff'
    for (const line of dom.lines) {
      for (let i = 0; i < line.text.length; i++) {
        if (line.text[i] === ' ') continue
        // the letter's origin on the page: the line's origin plus the advance of what comes before it (kerning included)
        const x = line.x + ctx.measureText(line.text.slice(0, i)).width, spot = layout.place(x, line.baseline), [ta, tb, tc, td] = spot.T
        ctx.setTransform(ta, tc, tb, td, spot.at[0], spot.at[1])
        ctx.fillText(line.text[i], 0, 0)
        ctx.setTransform(1, 0, 0, 1, 0, 0)
      }
    }
    map.needsUpdate = true
    // where the texture has lettering (the shader skips its reads elsewhere), padded for the mip filter's reach
    const box = [[dom.inkLeft, dom.top], [dom.inkRight, dom.top], [dom.inkRight, dom.bottom + .25 * dom.fontSize], [dom.inkLeft, dom.bottom + .25 * dom.fontSize]]
      .map(([x, y]) => layout.place(x, y).at), pad = .02
    uniforms.inked.value.set(Math.min(...box.map(p => p[0])) / size - pad, 1 - Math.max(...box.map(p => p[1])) / size - pad,
      Math.max(...box.map(p => p[0])) / size + pad, 1 - Math.min(...box.map(p => p[1])) / size + pad)
    // into the world: the plane hangs in front of the resting camera, facing it
    restPose()
    state.layout = layout
    state.anchor.set(...layout.centre).applyQuaternion(restTurn).add(restPosition)
    mesh.position.copy(state.anchor); mesh.quaternion.copy(restTurn)
    state.base.set(GLASS.plane[0] * layout.s, GLASS.plane[1] * layout.s, layout.s)
    uniforms.unit.value = layout.unit; uniforms.reference.value = layout.reference
    // the ink box's corners on the plane (for the pointer): page px -> texture px -> plane -> local position
    const toLocal = (x, y) => {
      const px = t0x + a * (x - p0x) + b * (y - p0y), py = t0y + c * (x - p0x) + d * (y - p0y)
      const [X, Y] = glassRestPlaneXY(px / size, 1 - py / size, layout.A, layout.k)
      return new THREE.Vector3(...glassVertex(X, Y))
    }
    state.corners = [[dom.inkLeft, dom.top], [dom.inkRight, dom.top], [dom.inkRight, dom.bottom], [dom.inkLeft, dom.bottom]].map(([x, y]) => toLocal(x, y))
    return true
  }

  const onMove = e => { state.pointer = e.pointerType === 'touch' ? null : [e.clientX, e.clientY] }
  const onOut = e => { if (!e.relatedTarget) state.pointer = null }
  addEventListener('pointermove', onMove, { passive: true })
  addEventListener('pointerout', onOut, { passive: true })
  const corner = new THREE.Vector3()
  const pointerOver = () => {
    if (!state.pointer || !state.corners.length || !state.box) return false
    const box = state.box
    const pts = state.corners.map(c => {
      corner.copy(c).applyMatrix4(mesh.matrixWorld).project(camera)
      return [box.left + (corner.x + 1) / 2 * box.width, box.top + (1 - corner.y) / 2 * box.height, corner.z]
    })
    if (pts.some(p => p[2] > 1)) return false
    // inside the quad: the same side of all four edges
    let sign = 0
    for (let i = 0; i < 4; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % 4], cross = (bx - ax) * (state.pointer[1] - ay) - (by - ay) * (state.pointer[0] - ax)
      if (cross === 0) continue
      if (sign === 0) sign = Math.sign(cross); else if (Math.sign(cross) !== sign) return false
    }
    return true
  }

  // Seen at all: the bent plane's box in the view, and the camera in front of at least one of its columns (it is
  // drawn from the front only). Otherwise there is nothing to draw: much of the scroll path has it off screen
  // or turned away, and three would still open and send a pass for it.
  const frustum = new THREE.Frustum(), viewProjection = new THREE.Matrix4(), bounds = new THREE.Box3(), eye = new THREE.Vector3()
  const seen = hover => {
    const lift = hover * GLASS.bulge[2]
    bounds.min.set(-.5, -.5 - .5 * GLASS.shear, GLASS.bulge[0] + lift)
    bounds.max.set(.5, .5 + .5 * GLASS.shear, GLASS.bulge[0] + GLASS.bulge[1] + lift)
    bounds.applyMatrix4(mesh.matrixWorld)
    viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    if (!frustum.setFromProjectionMatrix(viewProjection, camera.coordinateSystem, camera.reversedDepth).intersectsBox(bounds)) return false
    // the camera in the mesh's own units (the facing test keeps its sign under the mesh's positive scale)
    mesh.worldToLocal(camera.getWorldPosition(eye))
    return COLUMNS.some(([x, z, nx, nz]) => (eye.x - x) * nx + (eye.z - z - lift) * nz > 0)
  }

  return {
    scene, mesh, uniforms, state,
    /** Once a frame, after the camera is posed. testing: the sharpness test is timing frames behind the loading
     *  screen (resolution.js); the name is then drawn at its full size, as it will be on the opening view. */
    frame(dt, now = performance.now(), testing = false) {
      if (!state.fonts || !lay() || !state.layout) { mesh.visible = false; return }
      if (!state.drawn) { block.dataset.glass = ''; state.drawn = true }
      // it grows in once the scene is shown, as their cards do (1.2 s, easeOutQuint, after 0.2 s)
      if (state.entry === null && document.querySelector('.experience')?.dataset.phase === 'ready') state.entry = now + GLASS.entry.delay
      const grow = state.entry === null ? 0 : reduced.matches ? 1 : easeOutQuint(Math.min(1, Math.max(0, (now - state.entry) / GLASS.entry.duration)))
      const shown = testing ? 1 : grow
      mesh.scale.copy(state.base).multiplyScalar(Math.max(shown, 1e-4))
      mesh.updateMatrixWorld()
      camera.updateMatrixWorld()
      // The strips follow the scroll only: the effect is measured from the camera's place on its path, before the
      // pointer's swing and drift (parallax.js), which still move the name on screen as they move everything.
      const path = base.valid ? base.position : camera.position
      if (base.valid) uniforms.viewFix.value.compose(base.position, base.quaternion, unitScale).invert().multiply(camera.matrixWorld)
      // distance, as their rig would see it
      const camDistance = GLASS.rest * path.distanceTo(state.anchor) / state.layout.restDistance
      uniforms.camDistance.value = camDistance
      const near = crange(camDistance, NAME.near[1], NAME.near[0], 0, 1), far = crange(camDistance, GLASS.fade[0], GLASS.fade[1], 1, 0)
      state.gate = state.gate === null ? +(scroll.eased < NAME.gate.until) : nameGate(state.gate, scroll.eased, dt)
      const gate = testing ? 1 : state.gate
      uniforms.alpha.value = near * gate
      const on = shown > 0 && near * far * gate > 0 && seen(uniforms.hover.value)
      // hover: eased 8% a 60 Hz frame towards 1 over the name, 0 elsewhere (no hover on touch)
      state.hovered = on && !testing && pointerOver()
      const k = 1 - (1 - GLASS.ease.hover) ** Math.min(6, Math.max(0, dt * 60))
      uniforms.hover.value += ((state.hovered ? 1 : 0) - uniforms.hover.value) * k
      mesh.visible = on
    },
    /** Draws the name onto the canvas, over the finished frame. */
    draw(renderer) {
      // Before it is ever shown it is drawn once at a speck's size, so its shaders are ready before it shows.
      const warming = !mesh.visible
      if (warming && (state.warmed || !state.layout)) return
      // Straight onto the canvas, as the post-processing pipeline itself draws: no colour conversion (the frame there
      // is already display-encoded; otherwise the renderer would draw into a target of its own and copy it over the
      // whole canvas) and no clear of its colour. Its depth is cleared, not loaded: nothing here tests against it
      // (the scene's own depth is read from the scene pass), and a clear costs less than reading it back.
      // Restored at once: the pipeline rebuilds itself if it finds them changed.
      const r = renderer, saved = [r.outputColorSpace, r.toneMapping, r.autoClear, r.autoClearColor, r.autoClearDepth, r.autoClearStencil]
      r.outputColorSpace = THREE.ColorManagement.workingColorSpace; r.toneMapping = THREE.NoToneMapping
      r.autoClear = true; r.autoClearColor = false; r.autoClearDepth = true; r.autoClearStencil = false
      if (warming) mesh.visible = true
      try { r.render(scene, camera) } finally {
        [r.outputColorSpace, r.toneMapping, r.autoClear, r.autoClearColor, r.autoClearDepth, r.autoClearStencil] = saved
        if (warming) mesh.visible = false
      }
      state.warmed = true
    },
    dispose() {
      removeEventListener('pointermove', onMove); removeEventListener('pointerout', onOut); removeEventListener('resize', mark)
      resized.disconnect()
      delete block.dataset.glass
      mesh.geometry.dispose(); material.dispose(); map.dispose()
    },
  }
}
