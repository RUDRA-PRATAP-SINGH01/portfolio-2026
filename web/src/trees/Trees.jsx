import { useEffect, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { loadTrees, TreeSystem } from './TreeSystem.js'

export function Trees({ world, tier, onError, onProgress }) {
  const [system, setSystem] = useState(null), ref = useRef(null)
  useEffect(() => {
    const controller = new AbortController(); let instance
    if (new URLSearchParams(location.search).has('noTrees') || !world.meta.trees) { onProgress?.(1); return }
    loadTrees(world.meta.trees, tier, controller.signal, onProgress).then((assets) => {
      if (!assets) return
      instance = new TreeSystem(assets, world, tier)
      if (controller.signal.aborted) { instance.dispose(); return }
      ref.current = instance; setSystem(instance)
      onProgress?.(1)
    }).catch((error) => { if (error.name !== 'AbortError') { console.error('Tree loading failed', error); onError?.(error.message) } })
    return () => { controller.abort(); ref.current = null; instance?.dispose(); setSystem(null) }
  }, [world, tier, onError, onProgress])
  useFrame(({ camera }) => {
    const s = ref.current
    if (s) { s.update(camera); if (import.meta.env.DEV) window.__foliageStats = s.stats }
  })
  return system ? <primitive object={system.group} dispose={null} /> : null
}
