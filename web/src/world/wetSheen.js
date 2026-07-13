import { Fn, If, cameraPosition, dot, mix, normalWorld, normalize, positionWorld, reflect, vec3 } from 'three/tsl'
import { skyRadiance } from './sky.js'
import { PBR_LEGACY } from './pbrLegacy.js'

// Wet ground and stone mirror the sky, blurred by their roughness and strongest at grazing angles (Fresnel, with a
// rough surface's lower ceiling), as far as the sky reaches them (the baked sky reach: under the canopy, little).
// Only wet pixels do the work (a real branch: they lie together on screen); the sky is read at a fixed mip, so the
// lookup is legal inside it. Returns light to add, like an emission.
// palette.pbr.wet: strength, level (the sky picture's mip; a wet surface's roughness of about .24 blurs it that much),
// flatten (how much of the normal map's relief the film of water evens out), band (rocks: metres above the water
// they are wet to; pbr.js).
export function wetSheen(world, { wet, normal, skyReach, roughness = .24 }) {
  const W = world.palette.pbr?.wet
  if (!W || !world.sky || PBR_LEGACY.has('wet')) return null
  return Fn(() => {
    // The normal (its frame comes from screen derivatives) and the sky reach are worked out before the branch:
    // WGSL allows derivatives only where every pixel of a group runs the same code.
    const out = vec3(0).toVar(), share = wet.toVar(), n = normalize(mix(normal, normalWorld, W.flatten)).toVar(), reach = skyReach.toVar()
    If(share.greaterThan(.01), () => {
      const view = normalize(cameraPosition.sub(positionWorld))
      const fresnel = dot(n, view).clamp(0, 1).oneMinus().pow(5).mul(.98 - roughness).add(.02)
      const mirrored = reflect(view.negate(), n)
      out.assign(skyRadiance(world.sky, normalize(vec3(mirrored.x, mirrored.y.abs(), mirrored.z)), W.level).mul(fresnel).mul(reach).mul(share).mul(W.strength))
    })
    return out
  })()
}
