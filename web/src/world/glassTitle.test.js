// The sliced-glass title (glassTitle.js) and the name's layout (glassName.js), in plain numbers.
// The shader itself was checked against Active Theory's original GLSL by rendering both on identical inputs
// (2026-11-16: identical on WebGL, within 3/255 on WebGPU); these tests guard the plain-JavaScript copy of its
// maths that the layout relies on, and the layout's promise: at rest the texture lands on the page's name.
import test from 'node:test'
import assert from 'node:assert/strict'
import { GLASS, glassRestA, glassRestPlaneXY, glassUV, glassVertex } from './glassTitle.js'
import { NAME, layoutName, titleFont } from './glassName.js'

const near = (a, b, tolerance, label) => assert.ok(Math.abs(a - b) <= tolerance, `${label}: ${a} vs ${b}`)

test('their numbers', () => {
  near(titleFont(18), 93.6, 1e-9, 'their size for 18 letters')       // .9 * range(18, 5, 20, 130, 100)
  near(titleFont(3), 117, 1e-9, 'short titles'); near(titleFont(40), 90, 1e-9, 'long titles')
  assert.deepEqual([GLASS.strips, GLASS.clean, GLASS.ramp, GLASS.slide, GLASS.tilt, GLASS.shear], [15, .9, 7, .1, .15, .42])
  // their near fade, the mirror image of the far one around the resting distance
  near(NAME.near[0] * GLASS.fade[0], GLASS.rest ** 2, 1e-9, 'near start'); near(NAME.near[1] * GLASS.fade[1], GLASS.rest ** 2, 1e-9, 'near end')
})

test('clean inside the band, strips outside it', () => {
  for (const vx of [-.39, .5, 1.39]) assert.equal(glassUV(.3, .5, vx).edges, 0, `clean at vViewDir.x ${vx}`)
  for (const vx of [-.5, 1.5, 4]) assert.ok(glassUV(.3, .5, vx).edges > 0, `strips at ${vx}`)
  assert.equal(glassUV(.3, .5, 1.5, 1).edges, 0, 'hover widens the band by one unit')
  // The strips: inside one, the picture runs on by its width plus `edges`, then jumps back by `edges` at its border.
  // With edges = 1/15 each strip shows its own width and the next one's, so every letter appears twice.
  const vx = 1.75, { edges } = glassUV(.3, .5, vx), strip = 1 / GLASS.strips
  assert.ok(edges > 0 && edges < 1)
  const before = glassUV(.3, .5, vx), ux = before.u - edges * ((before.u - edges * 0) * 0)   // (the shifted coordinate)
  const plain = u => (u - .5) * (1 / (.42 * 1.15)) + .5 - (.5 - vx) * .1                       // the coordinate before the strips
  const at = X => glassUV(X, .5, vx).u, X0 = .3, u0 = plain(X0), k0 = Math.ceil(u0 * GLASS.strips) / GLASS.strips
  const Xb = .5 + (k0 - (.5 - (.5 - vx) * .1)) / (1 / (.42 * 1.15))                           // the plane x of that strip's border
  near(at(Xb - 1e-9) - at(Xb + 1e-9), edges, 1e-6, 'the jump at a strip border')
  assert.ok(Number.isFinite(ux) && strip > 0)
})

test('the rest inverse undoes the shader', () => {
  for (const k of [1, 1.9]) for (const A of [-1, .3, 1.2]) for (const [u, v] of [[.31, .42], [.5, .5], [.66, .61]]) {
    const [X, Y] = glassRestPlaneXY(u, v, A, k)
    const vx = A - GLASS.plane[0] * k * (X - .5)                  // across a plane that faces the camera
    if (Math.abs(vx - .5) > GLASS.clean) continue                 // (only meaningful where it is clean)
    const out = glassUV(X, Y, vx)
    near(out.u, u, 1e-12, `u (k ${k}, A ${A})`); near(out.v, v, 1e-12, `v (k ${k}, A ${A})`)
  }
  // glassRestA puts the asked-for vViewDir.x at the asked-for texture u
  for (const k of [1, 1.9]) {
    const A = glassRestA(.42, 1.1, k), [X] = glassRestPlaneXY(.42, .5, A, k)
    near(A - GLASS.plane[0] * k * (X - .5), 1.1, 1e-12, `vViewDir.x at u .42 (k ${k})`)
  }
  assert.deepEqual(glassVertex(.5, .5), [0, 0, GLASS.bulge[0] + GLASS.bulge[1]])
})

// hatom's layout at 1600 x 900 and on a phone (measured on the page, 2026-11-16)
const cases = [
  { view: { width: 1600, height: 900, fovY: 44.3725 }, dom: { fontSize: 46.6667, inkLeft: 170.4, centre: [266.65, 427.45] } },
  { view: { width: 390, height: 844, fovY: 44.3725 }, dom: { fontSize: 24, inkLeft: 20.2, centre: [69.9, 179.1] } },
]

test('at rest the texture lands on the page\'s name, level and at its size', () => {
  for (const { view, dom } of cases) {
    const L = layoutName(view, dom, { font: titleFont(18) }), [p0x, p0y] = dom.centre, [t0x, t0y] = L.texCentre
    const scale = dom.fontSize / 46.6667
    // the texture's centre lands on the name's centre
    const c0 = L.project(t0x, t0y); near(c0[0], p0x, .01, `centre x on ${view.width}`); near(c0[1], p0y, .01, `centre y on ${view.width}`)
    for (const [dx, dy] of [[0, 0], [-90, -60], [95, 60], [-90, 60], [95, -60], [10, 30]].map(([x, y]) => [x * scale, y * scale])) {
      // each letter is placed exactly where its page position is ...
      const spot = L.place(p0x + dx, p0y + dy), [sx, sy] = L.project(...spot.at)
      near(sx, p0x + dx, .02, `x at (${dx.toFixed(0)}, ${dy.toFixed(0)}) on ${view.width}`)
      near(sy, p0y + dy, .02, `y at (${dx.toFixed(0)}, ${dy.toFixed(0)}) on ${view.width}`)
      // ... and drawn through the inverse of the transform there: a letter's own size comes out at the page's
      const [ta, tb, tc, td] = spot.T, h = 10 * scale, ex = L.project(spot.at[0] + ta * h, spot.at[1] + tc * h), ey = L.project(spot.at[0] + tb * h, spot.at[1] + td * h)
      near(ex[0] - sx, h, .02, 'a letter\'s width'); near(ex[1] - sy, 0, .02, 'level'); near(ey[1] - sy, h, .02, 'a letter\'s height'); near(ey[0] - sx, 0, .02, 'upright')
    }
    // one straight transform alone would be out by a little at the far ends (the bulge): that is why letters are placed one by one
    const [a, b, c, d] = L.T, corner = L.project(t0x + a * -90 * scale + b * -60 * scale, t0y + c * -90 * scale + d * -60 * scale)
    assert.ok(Math.abs(corner[0] - (p0x - 90 * scale)) < 3, 'the straight transform is close')
    assert.ok(L.unit > 0 && L.s > L.unit, 'the shader reads position faster than the letters scale')
    near(L.s / L.unit, NAME.travel, 1e-12, 'travel')
    assert.ok(L.restDistance > NAME.depth, 'the plane hangs off-axis at the asked depth')
  }
})

test('at rest only the ends of the widest line touch the strips, by about a pixel', () => {
  // The layout assumes no strips at rest. With the faster position input (NAME.travel) the widest line is a little
  // wider than their clean band, so its ends sit at the very start of the ramp: what the shader really reads there,
  // against what the layout assumed, in page px.
  for (const { view, dom } of cases) {
    const L = layoutName(view, dom, { font: titleFont(18) }), size = GLASS.textureSize, inkRight = 2 * dom.centre[0] - dom.inkLeft
    let worst = 0, inRamp = 0, steps = 0
    for (let x = dom.inkLeft; x <= inkRight; x += .25, steps++) {
      const spot = L.place(x, dom.centre[1]), u = spot.at[0] / size, v = 1 - spot.at[1] / size
      const [X, Y] = glassRestPlaneXY(u, v, L.A, L.k), out = glassUV(X, Y, L.A - GLASS.plane[0] * L.k * (X - .5))
      if (out.edges > 0) inRamp++
      worst = Math.max(worst, Math.abs(out.u - u) * size / spot.T[0])
    }
    assert.ok(inRamp / steps < .25, `on ${view.width}: ${(100 * inRamp / steps).toFixed(1)}% of the line in the ramp`)
    assert.ok(worst <= .03 * dom.fontSize, `on ${view.width}: up to ${worst.toFixed(2)} px off`)
    assert.ok(glassUV(.5, .5, L.A, 1).edges === 0, 'hovered, all of it is clean')
  }
})
