import * as THREE from 'three/webgpu'
import { Fn, If, max, min, pass, rtt, saturation, screenSize, texture3D, uv, vec2, vec4 } from 'three/tsl'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { fxaa } from 'three/addons/tsl/display/FXAANode.js'
import { COLOR_SETTINGS } from './colorManagement.js'
import { atmosphere, openSky } from './atmosphere.js'
import { liquid } from './fluid.js'
import { SKY_LEGACY } from './sky.js'

export function blenderDisplay(hdr, look) {
  const linear = saturation(hdr.rgb, COLOR_SETTINGS.saturation).max(0)
  const shaped = linear.mul(look.scale).add(1).log2().div(look.shaper).clamp()
  const uvw = shaped.mul((look.size - 1) / look.size).add(.5 / look.size)
  // The LUT contains display-encoded sRGB. It is data, never an sRGB texture.
  return vec4(texture3D(look.texture, uvw).rgb, 1)
}

// Sharpening for a frame drawn with fewer dots than the screen has points (resolution.js) and stretched over it
// by the browser: each dot is pushed away from the average of its four neighbours, but never past the darkest or
// the lightest of them, so edges steepen without halos. Five readings of the finished 8-bit frame.
export function sharpen(frame, amount = .45) {
  const p = uv(), t = vec2(1).div(screenSize)
  const c = frame.sample(p).rgb
  const n = frame.sample(p.add(vec2(0, t.y))).rgb, s = frame.sample(p.sub(vec2(0, t.y))).rgb
  const e = frame.sample(p.add(vec2(t.x, 0))).rgb, w = frame.sample(p.sub(vec2(t.x, 0))).rgb
  const low = min(c, min(min(n, s), min(e, w))), high = max(c, max(max(n, s), max(e, w)))
  return vec4(c.mul(1 + 4 * amount).sub(n.add(s).add(e).add(w).mul(amount)).clamp(low, high), 1)
}

// FXAA, except where a pixel and its four neighbours all show the open sky (alpha 0 in `mask`, the graded frame):
// the sky has no edges to smooth there, and FXAA took a quarter off every star's peak (a star a pixel wide is its
// worst case: it shifts the peak onto a neighbour). Two bilinear readings at opposite corners of the pixel cover
// it and its four neighbours; edges of leaves and branches against the sky are smoothed as before.
function antialias(frame, mask) {
  const smoothed = fxaa(frame)
  if (SKY_LEGACY.has('fxaa')) return smoothed
  return Fn(() => {
    const p = uv(), half = vec2(.5).div(screenSize), out = vec4(0).toVar()
    If(mask.sample(p.add(half)).a.add(mask.sample(p.sub(half)).a).lessThan(.002), () => { out.assign(frame.sample(p)) })
      .Else(() => { out.assign(smoothed) })
    return vec4(out.rgb, 1)
  })()
}

export function createDisplayPipeline(renderer, scene, camera, look, { bloomEnabled = true, world = null, fluid = null, raw = false } = {}) {
  const pipeline = new THREE.RenderPipeline(renderer)
  const scenePass = pass(scene, camera, { samples: 0, type: THREE.HalfFloatType })
  // Ground mist and the lamps' glow in the air are added from scene depth, in scene-linear light (atmosphere.js).
  const rendered = scenePass.getTextureNode('output')
  pipeline.outputColorTransform = false
  // raw (development, ?guard): the scene pass as it is drawn, with no mist, glow, look or anti-aliasing, so the
  // keep-out marker (Terrain.jsx) reaches the screen unchanged.
  if (raw) {
    pipeline.outputNode = rendered
    return { pipeline, sceneDepth: null, render() { pipeline.render() }, dispose() { pipeline.dispose(); scenePass.dispose() } }
  }
  const depth = scenePass.getTextureNode('depth')
  const color = world ? atmosphere(rendered, depth, camera, world) : rendered
  const glow = bloom(color, COLOR_SETTINGS.bloomStrength, COLOR_SETTINGS.bloomRadius, COLOR_SETTINGS.bloomThreshold)
  // The graded image is display-encoded, like the canvas: anti-aliasing reads it from an 8-bit target with no
  // depth buffer (fxaa() would otherwise render it into a 16-bit float target with one). Its alpha marks the open
  // sky with 0 (antialias()).
  const display = blenderDisplay(bloomEnabled ? color.add(glow) : color, look)
  const graded = rtt(SKY_LEGACY.has('fxaa') ? display : vec4(display.rgb, openSky(depth).select(0, 1)), null, null, { type: THREE.UnsignedByteType, depthBuffer: false })
  pipeline.outputNode = antialias(graded, graded)
  // The cursor liquid (fluid.js) pushes the finished frame along its flow, mist and glow included (pushed before
  // the mist, the mist would stay where it is while the things under it moved); then anti-aliasing, as before.
  // A second output shares everything above and adds that pass; it is drawn only while the fluid has ink, so a
  // still page pays nothing for it (the pass costs ~0.35 ms on the Intel laptop).
  const distorted = fluid && rtt(liquid(graded, fluid.output), null, null, { type: THREE.UnsignedByteType, depthBuffer: false })
  const wet = fluid && new THREE.RenderPipeline(renderer)
  if (wet) { wet.outputColorTransform = false; wet.outputNode = antialias(distorted, graded) }
  let warm = !wet
  const size = new THREE.Vector2()
  // The sharpened outputs (one more pass each) are built the first time they are asked for: most visits never are.
  const byte = { type: THREE.UnsignedByteType, depthBuffer: false }, sharpened = {}
  const sharpOf = (key, source) => {
    if (!sharpened[key]) {
      const target = rtt(antialias(source, graded), null, null, byte), out = new THREE.RenderPipeline(renderer)
      out.outputColorTransform = false; out.outputNode = sharpen(target)
      sharpened[key] = { out, target }
    }
    return sharpened[key].out
  }
  return {
    pipeline,
    // The scene pass's depth (the same texture object through resizes), for things drawn over the finished frame
    // that should hide behind the scene (glassName.js). A plain texture, not the pass's texture node: that node
    // would tie the pass to whatever reads it.
    sceneDepth: scenePass.getTexture('depth'),
    render(sharp = false) {
      // A fixed height keeps the halo's angular size stable through DPR,
      // viewport and adaptive-quality changes, with a bounded GPU cost.
      renderer.getDrawingBufferSize(size)
      glow.setResolutionScale(COLOR_SETTINGS.bloomHeight / Math.max(1, size.y))
      // The first frame builds the liquid's output too (its shaders), so the first pointer move does not stall.
      if (!warm) { wet.render(); warm = true }
      const flowing = wet && !fluid.asleep
      ;(sharp ? sharpOf(flowing ? 'wet' : 'still', flowing ? distorted : graded) : flowing ? wet : pipeline).render()
    },
    dispose() {
      for (const { out, target } of Object.values(sharpened)) { out.dispose(); target.dispose() }
      pipeline.dispose()
      wet?.dispose()
      scenePass.dispose()
      glow.dispose()
      graded.dispose()
      distorted?.dispose()
    },
  }
}
