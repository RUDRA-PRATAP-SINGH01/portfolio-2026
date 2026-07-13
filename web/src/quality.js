// Quality tiers. Grass = Blender's real tufts; tiers only change LOD aggressiveness and ribbon rows. The pixel ratio
// is the same rule on every tier: one dot per point, raised to hatom's cap where our timing allows (world/resolution.js).
//   lodNear: distance (m) up to which every blade is kept; beyond it blades thin as (lodNear / d)^1.25, survivors widen.
//   lodMin: minimum kept fraction; lodFar: grass fades out completely; bladeKeep: global blade fraction.
//   level: the running controller's starting level (AdaptiveQuality.jsx).
// foliageNear, foliageFar: metres between the camera and a block of canopy (trees/TreeSystem.js) at which its
// near leaves give way to mid sprays, and its mid sprays to far ones. The three are lit differently: keep these
// distances and the moon shadows identical on every tier, so that all devices see the
// same canopy colour.
const appearance = { foliageNear: 2, foliageFar: 12 }
export const TIERS = {
  high:   { ...appearance, label: 'High',   level: 0, segments: 3, lodNear: 9.0, lodMin: 0.10, lodFar: 60, bladeKeep: 1.0 },
  medium: { ...appearance, label: 'Medium', level: 1, segments: 3, lodNear: 6.5, lodMin: 0.08, lodFar: 50, bladeKeep: 0.8 },
  low:    { ...appearance, label: 'Low',    level: 2, segments: 2, lodNear: 4.5, lodMin: 0.06, lodFar: 40, bladeKeep: 0.55 },
}

export const PHONE = /Mobi|Android|iPhone|iPad|iPod/i.test(globalThis.navigator?.userAgent ?? '')
// Phones load the lighter texture files: the `_low` ground and statue maps, the 512 rock and soil maps (desktops the
// 1024 ones, since 2026-11-17). ?texLow (development) makes a desktop load the phone's, for comparisons.
export const TEXTURES_LOW = PHONE || !!(import.meta.env?.DEV && typeof location !== 'undefined' && new URLSearchParams(location.search).has('texLow'))

// WebGPU that works on this chip. A browser can offer navigator.gpu and still give no adapter (a blocklisted chip);
// three then draws with WebGL2, and such a visit starts on Low with the 2k sky (sky.js), like a browser without it.
export const WEBGPU = !!(globalThis.navigator?.gpu && await navigator.gpu.requestAdapter().catch(() => null))

export function defaultTier() {
  return WEBGPU && !PHONE ? 'high' : 'low'
}
