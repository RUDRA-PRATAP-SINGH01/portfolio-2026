import { useEffect, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { GrassSystem, loadTufts } from './GrassSystem.js'

// R3F wrapper: loads Blender's tufts, builds the GPU grass, runs the per-tuft compute every frame.
export function Grass({ world, tier, pointerRef, onReady, onError }) {
  const { gl, scene, size } = useThree()
  const [system, setSystem] = useState(null)
  useEffect(() => {
    let sys = null, cancelled = false
    loadTufts(world.meta).then((tufts) => {
      if (cancelled) { tufts.texA.dispose(); tufts.texB.dispose(); return }
      sys = new GrassSystem({ world, renderer: gl, tier, tufts })
      scene.add(sys.group); setSystem(sys); onReady?.(sys)
    }).catch(error => { if (!cancelled) onError?.(`Grass: ${error.message}`) })
    return () => { cancelled = true; if (sys) { scene.remove(sys.group); sys.dispose() } }
  }, [world, gl, tier, scene, onReady, onError])
  useFrame((state, delta) => {
    if (!system) return
    const p = pointerRef?.current
    system.setPointer(p?.active ? p.point : null, p?.velocity)
    system.update(state.camera, size.height * state.viewport.dpr, delta)
  }, -1)
  return null
}
