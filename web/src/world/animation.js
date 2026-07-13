import { uniform, sin, cos, vec2 } from 'three/tsl'

// One clock for the main view and reflections. Reduced motion keeps it at zero.
export const motionTime = uniform(0)
export const motionEnabled = uniform(1)
// 1 while the pond renders its reflection: far-detail leaf cards then stand in for every tree (TreeSystem).
export const reflectionPass = uniform(0)
export const waveHeight = p => sin(p.x.mul(.85).add(p.y.mul(.52)).add(motionTime.mul(.65))).mul(.006)
  .add(sin(p.x.mul(-.43).add(p.y.mul(1.12)).sub(motionTime.mul(.42))).mul(.003))
export const waveSlope = p => {
  const a = cos(p.x.mul(.85).add(p.y.mul(.52)).add(motionTime.mul(.65)))
  const b = cos(p.x.mul(-.43).add(p.y.mul(1.12)).sub(motionTime.mul(.42)))
  return vec2(a.mul(.0051).sub(b.mul(.00129)),a.mul(.00312).add(b.mul(.00336)))
}

// Validate a swept footprint once at load time, including rocks and the shore.
export function safeDrift(world, x, z, radius, requested) {
  for (const drift of [requested, requested*.75, requested*.5, requested*.25, requested*.125, 0]) {
    const reach = radius + drift
    if ((world.floatObstacles ?? []).some(o => Math.hypot(x-o.x,z-o.z) < reach+o.radius)) continue
    let safe = true
    for (const ring of [0,.5,1]) for (let i=0;i<32;i++) {
      const a=i*Math.PI/16
      if (world.heightAt(x+Math.cos(a)*reach*ring,z+Math.sin(a)*reach*ring) > world.meta.water_level-.025) safe=false
    }
    if (safe) return drift
  }
  return 0
}
