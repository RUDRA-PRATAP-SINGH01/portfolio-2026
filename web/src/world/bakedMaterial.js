import * as THREE from 'three/webgpu'
import { cameraPosition, cameraViewMatrix, dot, mix, normalMap, normalWorld, normalize, positionWorld, vec3 } from 'three/tsl'

// The one way every surface but the statue is lit: colour x baked light, with no live light and no shadow map.
//
//   colour = albedo x ( light + moon x reach x max(N.L, 0) ) + moon highlight + emission
//
//   light   baked: a light map or the light grid (cinematic.js). It holds the lamps, the sky and the moon's bounce.
//   reach   the baked share of the moon that reaches the point (0 in a shadow, 1 in the open).
//   N       the surface's normal with its normal map, so direct moonlight keeps the relief of bark, rock and soil,
//           and a small highlight follows the roughness map.
// Materials are MeshBasicNodeMaterial: the renderer's lighting does not run at all.

// Direct moonlight on a matte surface facing the moon: colour x strength / pi, as Cycles and three.js both have it.
export function moonLight(world) {
  const { direction_to_scene: d, color, strength } = world.meta.moon
  const toward = new THREE.Vector3(...d).normalize().negate()
  return { toward: vec3(toward.x, toward.y, toward.z), colour: vec3(...color.map(c => c * strength / Math.PI)), shadow: world.palette.moon.shadow }
}

// World-space normal from a tangent-space normal map; works in any material.
export const mappedNormal = (mapNode, scale) => normalMap(mapNode, scale).transformNormalByInverseViewMatrix(cameraViewMatrix)

// The moon's highlight (GGX, the standard material's), as radiance per unit of moonLight().colour.
export function moonHighlight(N, toward, roughness, p = positionWorld) {
  const view = normalize(cameraPosition.sub(p)), half = normalize(view.add(toward))
  const a = roughness.mul(roughness).max(.02), a2 = a.mul(a)
  const nl = dot(N, toward).max(0), nv = dot(N, view).max(.05), nh = dot(N, half).max(0)
  const spread = nh.mul(nh).mul(a2.sub(1)).add(1)
  const masking = nl.mul(nv.mul(nv).mul(a2.oneMinus()).add(a2).sqrt()).add(nv.mul(nl.mul(nl).mul(a2.oneMinus()).add(a2).sqrt())).max(1e-4)
  const fresnel = dot(view, half).oneMinus().max(0).pow(5).mul(.96).add(.04)
  // D x V x F x N.L x pi: moonLight().colour already carries the 1 / pi of a matte surface
  return nl.mul(a2).mul(.5).div(spread.mul(spread).mul(masking)).mul(fresnel)
}

// The lit colour of a surface (see the top of the file). `reach` and `roughness` are optional: without reach the
// surface gets no direct moonlight (it is in `light` already, as for twigs); without roughness no highlight.
export function bakedColour(world, { albedo, light, reach = null, normal = normalWorld, roughness = null, emission = null, highlight = 1 }) {
  const moon = moonLight(world)
  let incoming = light, shine = null
  if (reach) {
    // moon.shadow: how dark a moon shadow gets (1 = no moonlight at all inside it).
    const arriving = moon.colour.mul(mix(1 - moon.shadow, 1, reach))
    incoming = incoming.add(arriving.mul(dot(normal, moon.toward).max(0)))
    if (roughness && highlight) shine = arriving.mul(moonHighlight(normal, moon.toward, roughness)).mul(highlight)
  }
  let colour = albedo.mul(incoming)
  if (shine) colour = colour.add(shine)
  if (emission) colour = colour.add(emission)
  return colour
}

export function bakedMaterial(options = {}) {
  return new THREE.MeshBasicNodeMaterial(options)
}

