// Weights in percent of the count (they add up to 100). resolution: the sharpness test drawn behind the loading
// screen after the warm-up (world/resolution.js; done at once on screens at one dot per point). It is the last
// thing to finish and takes up to three seconds on a slow chip, so it owns the last five numbers of the count:
// they tick over while it runs (AdaptiveQuality.jsx reports how far along it is).
const WEIGHTS = { renderer: 4, world: 18, head: 15, trees: 30, details: 20, grass: 5, frame: 3, resolution: 5 }
export const CHAPTERS = [
  { label: 'Shaping the landscape', keys: ['renderer', 'world'] },
  { label: 'Waking the guardian', keys: ['head'] },
  { label: 'Unfolding the canopy', keys: ['trees'] },
  { label: 'Gathering the blossoms', keys: ['details', 'grass'] },
  { label: 'Finding the light', keys: ['frame', 'resolution'] },
]

// Fixed weights keep progress monotonic even when nested GLB textures and
// manifests discover more work. Only completed loading/assembly advances it.
export function createLoadingSession({ worldReady = false, intro = true } = {}) {
  const values = Object.fromEntries(Object.keys(WEIGHTS).map(key => [key, 0]))
  if (worldReady) values.world = 1
  const listeners = new Set()
  let error = null
  const snapshot = () => ({
    progress: Object.entries(WEIGHTS).reduce((sum, [key, weight]) => sum + values[key] * weight, 0),
    chapter: CHAPTERS.findIndex(chapter => chapter.keys.some(key => values[key] < 1)),
    ready: Object.values(values).every(value => value === 1),
    error,
  })
  let current = snapshot()
  const publish = () => { current = snapshot(); listeners.forEach(listener => listener()) }
  const report = (key, value) => {
    if (error || !(key in values) || !Number.isFinite(value)) return
    const next = Math.max(values[key], Math.min(1, Math.max(0, value)))
    if (next === values[key]) return
    values[key] = next; publish()
  }
  return {
    intro,
    getSnapshot: () => current,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    assetsReady: () => Object.keys(WEIGHTS).every(key => key === 'frame' || key === 'resolution' || values[key] === 1),
    report,
    fail: message => { if (!error) { error = String(message); publish() } },
    // Stable callbacks: progress updates must never restart an asset effect.
    world: value => report('world', value),
    head: value => report('head', value),
    trees: value => report('trees', value),
    details: value => report('details', value),
  }
}
