import { mix, positionWorld, smoothstep, texture, uniform, varying } from 'three/tsl'

// Height of a point above the terrain beneath it, from the height map the ground mesh is built from.
export function heightAboveGround(world, p = positionWorld) {
  const uvS = uniform(world.uvScale), uvO = uniform(world.uvOffset)
  return p.y.sub(texture(world.heightTexture, p.xz.mul(uvS).add(uvO)).level(0).r)
}

// Occlusion of things that stand on the ground: darkest where they meet it, gone `reach` metres above.
// Evaluated per vertex; pairs with the baked contact map on the terrain itself (bake_ground_contact.py).
export function groundContact(world, reach = .4, strength = .5) {
  return mix(1 - strength, 1, smoothstep(0, reach, varying(heightAboveGround(world))))
}
