import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { createDisplayPipeline } from './displayPipeline.js'
import { createFluid } from './fluid.js'
import { RESOLUTION, SLOW, bounds, drawing, gpuFinished, resolution } from './resolution.js'
import { adaptive } from './AdaptiveQuality.jsx'
import { warmup } from '../loading/warmup.js'
import { GLASS_NAME, createGlassName } from './glassName.js'
import { OUTRO_ON } from '../outro/timeline.js'
import { createWipe } from '../outro/wipe.js'

// Atmosphere and bloom in scene-linear HDR, then the saved Blender AgX Punchy display transform.
// FXAA consumes display-encoded sRGB, after the look, with no second tone mapping.
// ?guard (development): the scene pass shown raw, for the keep-out check (Terrain.jsx, scripts/check-path-guard.mjs).
const GUARD = import.meta.env.DEV && new URLSearchParams(location.search).has('guard')

export function Post({ world }) {
  const { gl, scene, camera } = useThree()
  // The cursor liquid: off with ?fluid=0 (comparisons) and for visitors who ask for reduced motion.
  const calm = useRef(false)
  const fluid = useMemo(() => new URLSearchParams(location.search).get('fluid') === '0' || GUARD ? null : createFluid(gl, gl.domElement), [gl])
  useEffect(() => {
    if (!fluid) return
    if (import.meta.env.DEV) window.__fluid = { fluid, gl }
    const reduced = matchMedia('(prefers-reduced-motion: reduce)'), motion = () => { calm.current = reduced.matches }
    motion(); reduced.addEventListener('change', motion)
    return () => { reduced.removeEventListener('change', motion); fluid.dispose() }
  }, [fluid])
  const pipeline = useMemo(() => createDisplayPipeline(gl, scene, camera, world.look, { world, fluid, raw: GUARD }), [gl, scene, camera, world, fluid])
  useEffect(() => () => pipeline.dispose?.(), [pipeline])
  // The name on the opening view, in Active Theory's sliced glass (glassName.js), drawn over the finished frame.
  const glass = useMemo(() => GLASS_NAME && pipeline.sceneDepth ? createGlassName({ world, camera, canvas: gl.domElement, sceneDepth: pipeline.sceneDepth }) : null, [world, camera, gl, pipeline])
  useEffect(() => {
    if (import.meta.env.DEV && glass) window.__glass = { glass, camera }
    return () => glass?.dispose()
  }, [glass, camera])
  // The light screen after the camera's path (outro/wipe.js), drawn over everything.
  const wipe = useMemo(() => OUTRO_ON && !GUARD ? createWipe(gl) : null, [gl])
  useEffect(() => () => wipe?.dispose(), [wipe])
  const queue = useRef({ busy: false, since: 0 }), sent = useRef([])
  useFrame((_, dt) => {
    const now = performance.now()
    // The sharpness test (below) is held to the chip too, loosely: no new frame while the chip is more than a
    // quarter of a second behind. It always has work, so the timing is the chip's own, and a slow chip (40 ms a
    // frame and more) is not left with many seconds of frames to finish before the loading screen may open.
    if (resolution.measuring) {
      const s = sent.current
      while (s.length && now - s[0] > 2000) s.shift()                  // (a signal that never came)
      if (s.length && now - s[0] > RESOLUTION.lagMs) return
    }
    // Behind the loading screen a frame is started only when the graphics chip has finished the one before it.
    // A canvas that is not on screen is not held to the chip's speed: left alone, the page queues frames faster
    // than a slow chip draws them (Intel laptop, 2026-11-13: a callback every 8 ms, 13 ms of work each), and when
    // the loading screen opens the browser puts nothing new on the screen until the chip has worked the queue off.
    // That was 1.1 seconds: the opening stood still, then appeared two thirds done. Paced, the queue is never
    // more than a frame deep, and the frames nobody sees no longer take the chip from the loading.
    // The sharpness test is let through: it times the chip at full load (resolution.js), and the loading screen
    // waits for its queue before it opens (AdaptiveQuality.jsx). A frame not reported finished within 400 ms no
    // longer holds the next one back.
    const paced = !adaptive.shown && !resolution.measuring, waiting = queue.current
    if (paced && waiting.busy && performance.now() - waiting.since < 400) return
    // The sharpness test draws each frame twice (resolution.js), the second time as a frame of its own for three's
    // once-a-frame passes (the scene pass, the pond's mirror), which otherwise would not draw again.
    const repeat = gl._nodes?.nodeFrame ? (resolution.measuring ? RESOLUTION.repeat : 1) * SLOW : 1
    // Drawn at less than one dot per point (a slow chip, resolution.js), the frame is sharpened as it is put out.
    const sharp = gl.getPixelRatio() < bounds(devicePixelRatio).floor - .001
    // Once the light fills the window, only it is drawn (not behind the loading screen, whose frames time the scene).
    const light = wipe?.frame(dt) && adaptive.ready
    // No cursor liquid for reduced motion, nor at the controller's lightest levels (AdaptiveQuality.jsx).
    if (fluid) fluid.enabled = !calm.current && adaptive.level < 3 && !light
    drawing.callback++
    if (light) wipe.draw(gl)
    else {
      glass?.frame(dt, now, resolution.measuring)     // (at full size while the sharpness test times the frames)
      for (let i = 0; i < repeat; i++) {
        if (i) gl._nodes.nodeFrame.update()
        if (fluid) { fluid.hold = resolution.measuring; fluid.update(dt) }
        pipeline.render(sharp)
        glass?.draw(gl)                       // over each finished frame (the sharpness test times it too)
        wipe?.draw(gl)
      }
    }
    warmup.drawn++
    if (resolution.measuring) { const s = sent.current; s.push(now); gpuFinished(gl).then(() => { s.shift() }) }
    if (paced) { waiting.busy = true; waiting.since = performance.now(); gpuFinished(gl).then(() => { waiting.busy = false }) }
  }, 1)
  return null
}
