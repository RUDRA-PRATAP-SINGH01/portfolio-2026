import * as THREE from 'three/webgpu'
import { Fn, If, abs, clamp, cos, dFdx, dFdy, float, fract, min, mix, positionLocal, positionView, screenUV, sin, smoothstep, step,
  texture, uniform, uv, vec2, vec3, vec4, depth } from 'three/tsl'

// The sliced-glass titles of activetheory.net/work (their shader WorkItemUIShader, read from the live site on
// 2026-11-15/16), ported to TSL. A title is drawn once into a texture and shown on a 4 x 2 plane of 100 columns
// (theirs: 100 x 50; the rows change nothing), added onto the frame. The vertex stage bows the plane toward the viewer and shears it; the fragment
// stage cuts the picture into 15 vertical strips, each restarting a little early (fract(uv.x * 15) * edges), so the
// letters repeat and shift, and splits red and blue apart. `edges` grows with the fragment's horizontal distance
// in view space from the middle of the view: a title is clean where it rests and breaks up as the camera carries it
// sideways. Hover widens the clean band, pushes the plane toward the viewer and brightens it; distance fades it.
// Every constant below is theirs. Two inputs are ours, and both are the identity for their scene:
//   unit       metres per unit of their scene (their scene is built in units where a card stands 3.8 from the
//              camera's rig); 1 = theirs
//   reference  the view-space x (metres) that counts as the middle of the view; 0 = theirs (the camera's axis)
// and `alpha` multiplies the result (1 = theirs).

/** Their numbers. */
export const GLASS = Object.freeze({
  plane: [4, 2], segments: [100, 50],    // World.PLANEHI scaled by the pane_ui mesh (4, 2, 1)
  textureSize: 1024,                     // WorkPaneUI's UI3D capture
  strips: 15, clean: .9, ramp: 7,        // edges = smoothstep(.9 + hover, 7, |vViewDir.x - .5|)
  bulge: [.1, .3, .2],                   // z += .1 + smoothstep(1, 0, |u - .5|) * .3 + hover * .2
  shear: .42, scale: [.42, 1.15], tilt: .15, slide: .1, lift: .02,
  split: [.001, .15], squash: .15,       // RGB split .001 - edges * .15 at 180 degrees; uv.y *= 1 - x * .15 * edges
  tint: .05, brightness: [.65, .9],      // 5% towards the card's hue; .65, .9 when hovered
  fade: [5, 6],                          // faded out between 5 and 6 units from the camera's rig
  rest: 3.8,                             // a card's distance from the camera's rig at rest
  ease: { hover: .08 },                  // per 60 Hz frame
  entry: { duration: 1200, delay: 200 }, // the card grows from nothing, easeOutQuint
})

// The bend depends on u only, so every column of the plane is flat: one row draws the same picture as their 50
// (position, uv and depth are affine across a flat strip, derivatives included), without 10,000 tiny triangles.
export const glassTitleGeometry = () => new THREE.PlaneGeometry(1, 1, GLASS.segments[0], 1)

// smoothstep with edge0 > edge1, as GLSL computes it (WGSL leaves that case undefined): the curve is symmetric,
// so smoothstep(a, b, x) = 1 - smoothstep(b, a, x).
const fall = (from, to, x) => smoothstep(to, from, x).oneMinus()
// their range.glsl
const crange = (v, oMin, oMax, nMin, nMax) => clamp(v.sub(oMin).mul(nMax - nMin).div(oMax - oMin).add(nMin), Math.min(nMin, nMax), Math.max(nMin, nMax))
// their rgb2hsv.fs
const rgb2hsv = c => {
  const K = vec4(0, -1 / 3, 2 / 3, -1)
  const p = mix(vec4(c.b, c.g, K.w, K.z), vec4(c.g, c.b, K.x, K.y), step(c.b, c.g))
  const q = mix(vec4(p.x, p.y, p.w, c.r), vec4(c.r, p.y, p.z, p.x), step(p.x, c.r))
  const d = q.x.sub(min(q.w, q.y)), e = float(1e-10)
  return vec3(abs(q.z.add(q.w.sub(q.y).div(d.mul(6).add(e)))), d.div(q.x.add(e)), q.x)
}
const hsv2rgb = c => {
  const K = vec4(1, 2 / 3, 1 / 3, 3)
  const p = abs(fract(c.xxx.add(K.xyz)).mul(6).sub(K.www))
  return c.z.mul(mix(K.xxx, clamp(p.sub(K.xxx), 0, 1), c.y))
}

/** The title shader as a node material for `map` (white title on black). With `sceneDepth` (the depth texture of
 *  the frame it is drawn over, same camera and size) things in front of the title hide it.
 *  side: theirs is seen from both sides (a card behind the ring shows its back); FrontSide hides the back.
 *  ink: [r, g, b] (0-1) for a map that holds only the lettering's coverage, in its red channel (a quarter of the
 *  memory): the colour the title would have in their texture. Without it the map is read as theirs is.
 *  Returns { material, uniforms: { hover, camDistance, color, unit, reference, alpha, inked } }; inked (u0, v0, u1, v1)
 *  is where the texture is not black (the whole texture by default). */
export function glassTitleMaterial(map, { sceneDepth = null, side = THREE.DoubleSide, ink = null } = {}) {
  const G = GLASS
  const hover = uniform(0), camDistance = uniform(G.rest), color = uniform(new THREE.Color('#5f7cff'))
  const unit = uniform(1), reference = uniform(0), alpha = uniform(1)
  // view space -> the view space the effect is measured in (identity = theirs; glassName.js: the camera on its path,
  // without the pointer's swing, so only scrolling moves the strips)
  const viewFix = uniform(new THREE.Matrix4())
  const vUv = uv()
  const material = new THREE.NodeMaterial()
  material.name = 'GlassTitle'
  // vertex: pos.z += .1 + smoothstep(1, 0, |vUv.x - .5|) * .3 + uHover * .2;  pos.y -= (vUv.x - .5) * .42
  material.positionNode = positionLocal.add(vec3(0, vUv.x.sub(.5).mul(G.shear).negate(),
    float(G.bulge[0]).add(fall(1, 0, abs(vUv.x.sub(.5))).mul(G.bulge[1])).add(hover.mul(G.bulge[2]))))
  // vViewDir = -(modelViewMatrix * pos).xyz: positionView is that product for the bent position. In their units,
  // measured from the reference.
  const vx = viewFix.mul(vec4(positionView, 1)).x.sub(reference).div(unit).negate()
  // fragment
  let st = vUv.sub(.5).div(vec2(G.scale[0], 1)).add(.5)                   // scaleUV(vUv, vec2(.42, 1))
  st = st.sub(.5).div(G.scale[1]).add(.5)                                 // scaleUV(uv, vec2(1.15))
  st = vec2(st.x, st.y.sub(st.x.sub(.5).mul(G.tilt)))                     // uv.y -= (uv.x - .5) * .15
  st = vec2(st.x.sub(float(.5).sub(vx).mul(G.slide)), st.y.add(G.lift))   // uv.x -= (.5 - vViewDir.x) * .1; uv.y += .02
  const edges = smoothstep(float(G.clean).add(hover), G.ramp, abs(vx.sub(.5)))
  const strip = fract(st.x.mul(G.strips))
  const sliced = vec2(st.x.add(strip.mul(edges)),                          // uv.x += fract(uv.x * 15) * edges
    st.y.sub(st.y.mul(vx).mul(G.squash).mul(edges)))                     // uv.y -= uv.y * vViewDir.x * .15 * edges
  // The texture has mipmaps, so it is read with the gradients of the strips' continuous part: across a strip's border
  // the coordinate jumps, and the automatic level would pick a blurred mip there. Without mipmaps this is a plain read.
  // Inside a strip x runs at d(st.x) (1 + 15 edges) + fract(15 st.x) d(edges); edges is smooth (0 across the kink of
  // the |x - .5|), so this is the exact derivative everywhere but at the borders. (Vertically there is no jump.)
  const stretch = edges.mul(G.strips).add(1)
  const dx = vec2(dFdx(st.x).mul(stretch).add(strip.mul(dFdx(edges))), dFdx(sliced.y))
  const dy = vec2(dFdy(st.x).mul(stretch).add(strip.mul(dFdy(edges))), dFdy(sliced.y))
  // getRGB(tMap, uv, radians(180), .001 - edges * .15)
  const angle = float(Math.PI), amount = float(G.split[0]).sub(edges.mul(G.split[1])), offset = vec2(cos(angle), sin(angle)).mul(amount)
  const read = at => texture(map, at).grad(dx, dy)
  // Most of the plane shows black (the texture is black outside its lettering, `inked`: u0, v0, u1, v1, padded for
  // the mip filter). Where all three reads fall outside it the result is black whatever follows, so that work is
  // skipped: the same picture, for less. (Their reads are offset sideways only: sin(180 degrees) is ~1e-7.)
  const inked = uniform(new THREE.Vector4(0, 0, 1, 1)), spread = abs(amount)
  const inside = sliced.y.greaterThanEqual(inked.y).and(sliced.y.lessThanEqual(inked.w))
    .and(sliced.x.add(spread).greaterThanEqual(inked.x)).and(sliced.x.sub(spread).lessThanEqual(inked.z))
  const shade = Fn(() => {
    const out = vec3(0).toVar()
    If(inside, () => {
      let rgb = ink
        ? vec3(read(sliced.add(offset)).r, read(sliced).r, read(sliced.sub(offset)).r).mul(vec3(...ink))
        : vec3(read(sliced.add(offset)).r, read(sliced).g, read(sliced.sub(offset)).b)
      rgb = rgb.mul(fall(.5, .4, abs(sliced.x.sub(.5)))).mul(fall(.5, .4, abs(sliced.y.sub(.5))))
      const base = rgb2hsv(color), hsv = rgb2hsv(rgb)
      rgb = mix(rgb, hsv2rgb(vec3(hsv.x.mul(.1).add(base.x).sub(.25), hsv.y.mul(base.y), hsv.z)), G.tint)
      rgb = rgb.mul(crange(camDistance, G.fade[0], G.fade[1], 1, 0)).mul(mix(G.brightness[0], G.brightness[1], hover)).mul(alpha)
      // Hidden where the frame it is added to has something nearer (its depth texture, read at this pixel).
      if (sceneDepth) rgb = rgb.mul(step(depth, texture(sceneDepth, screenUV).r))
      out.assign(rgb)
    })
    return out
  })
  material.fragmentNode = vec4(shade(), 1)
  material.transparent = true
  material.blending = THREE.AdditiveBlending
  material.depthTest = false
  material.depthWrite = false
  material.side = side
  material.forceSinglePass = true      // (a transparent two-sided material would otherwise be drawn twice, back then front)
  material.fog = false
  return { material, uniforms: { hover, camDistance, color, unit, reference, alpha, inked, viewFix } }
}

// ---------------------------------------------------------------------------------------------------- plain maths
// The same transforms in plain JavaScript, for laying a title out and for tests.

export const smoothstepJS = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }
const A1 = 1 / (GLASS.scale[0] * GLASS.scale[1])                          // vUv.x to uv.x before the slide

/** The shader's texture coordinates for plane coordinates (X, Y) = vUv and vViewDir.x = vx (their units). */
export function glassUV(X, Y, vx, hover = 0) {
  const G = GLASS
  let ux = (X - .5) * A1 + .5, uy = (Y - .5) / G.scale[1] + .5
  uy -= (ux - .5) * G.tilt
  ux -= (.5 - vx) * G.slide
  uy += G.lift
  const edges = smoothstepJS(G.clean + hover, G.ramp, Math.abs(vx - .5))
  ux += (ux * G.strips - Math.floor(ux * G.strips)) * edges
  uy -= uy * vx * G.squash * edges
  return { u: ux, v: uy, edges }
}

/** The bent plane's local position (before the mesh's scale) for plane coordinates (X, Y). */
export function glassVertex(X, Y, hover = 0) {
  const G = GLASS
  return [X - .5, Y - .5 - (X - .5) * G.shear, G.bulge[0] + (1 - smoothstepJS(0, 1, Math.abs(X - .5))) * G.bulge[1] + hover * G.bulge[2]]
}

/** Inverse of glassUV for a resting title (no strips): the plane coordinates where the texture point (u, v) shows,
 *  when vViewDir.x = A - 4 k (X - .5) across the plane (a plane facing the camera; A = its value at the middle;
 *  k = the mesh's metres per unit over the shader's `unit`, 1 in their scene). */
export function glassRestPlaneXY(u, v, A, k = 1) {
  const G = GLASS, w = G.plane[0]
  const X = .5 + (u - (.5 - .5 * G.slide) - G.slide * A) / (A1 - w * k * G.slide)
  const Y = .5 + G.scale[1] * (v - .5 - G.lift + G.tilt * A1 * (X - .5))
  return [X, Y]
}

/** A for a resting title whose texture point u = uLeft must have vViewDir.x = vxLeft. */
export function glassRestA(uLeft, vxLeft, k = 1) {
  const G = GLASS, w = G.plane[0] * k, K = A1 - w * G.slide
  return (vxLeft + w * (uLeft - (.5 - .5 * G.slide)) / K) / (1 + w * G.slide / K)
}

/** Horizontal texture coordinate per plane coordinate at rest (it sets how wide a strip is on the plane). */
export const glassRestStretch = (k = 1) => A1 - GLASS.plane[0] * k * GLASS.slide
