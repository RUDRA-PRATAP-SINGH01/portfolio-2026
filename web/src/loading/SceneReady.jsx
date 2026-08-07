import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { warmup } from './warmup.js'
import { gpuFinished } from '../world/resolution.js'

export function SceneReady({ session, world }) {
  const progress = useRef({ started: false, frames: 0, first: 0, seconds: 0, culled: [], finished: false })
  // Priority 2 runs after Post has actually drawn the full scene. Asset downloads
  // alone are not enough: wait for texture uploads and reflected frames.
  useFrame(({ scene, gl }, dt) => {
    if (progress.current.finished || !session.assetsReady() || session.getSnapshot().ready || session.getSnapshot().error) return
    const expected = ['Terrain', 'ReflectivePond', 'SculptedMoai', 'ProceduralGrass']
    if (world.sceneManifest) expected.push('ForestDetails')
    if (world.meta.trees && !new URLSearchParams(location.search).has('noTrees')) expected.push('OptimizedTrees')
    if (expected.some(name => !scene.getObjectByName(name))) return
    const state = progress.current
    // The frames counted here are drawn behind the loading screen with everything that is normally hidden or
    // outside the view switched on (warmup.js, no frustum culling). Each shader, pipeline, vertex buffer and texture is then created now, rather than in the middle
    // of the visitor's first camera move.
    // Twelve of them, counted as they are drawn: behind the loading screen Post.jsx starts a frame only when the
    // graphics chip has finished the one before, so by the twelfth the chip has really drawn the others.
    if (!state.started) {
      state.started = true; warmup.active = true; warmup.done = false; state.first = warmup.drawn
      scene.traverse(object => { if ((object.isMesh || object.isSprite) && object.frustumCulled) { object.frustumCulled = false; state.culled.push(object) } })
    }
    state.frames = warmup.drawn - state.first; state.seconds += Math.min(dt, .1)
    const done = Math.min(1, state.frames / 12, state.seconds / .45)
    if (done < 1) return void session.report('frame', done * .9)
    warmup.active = false; warmup.done = true; state.finished = true    // back to the normal state
    state.culled.forEach(object => { object.frustumCulled = true }); state.culled = []
    // The session hears of the last frame when the chip has finished it: the loading screen must not open onto
    // frames still waiting to be drawn (Post.jsx).
    gpuFinished(gl).then(() => session.report('frame', 1))
  }, 2)
  return null
}
