// ?pbrLegacy (development): the environment's PBR as it was before 2026-11-17, so the look and the cost of each part
// can be compared. Bare, every part; =relief,wet (for instance) only the parts named:
//   relief  light maps scaled by the light grid along the normal map (relief.js)
//   shore   the island's shore patch reads the ground's normal maps
//   wet     wet ground and rocks reflect the sky (wetSheen.js)
//   unused  the soil roughness map and the twig normal map, which change nothing on screen, loaded and read
//   aniso   the soil and ground roughness maps filtered at 4x anisotropy (8x now)
export const PBR_PARTS = ['relief', 'shore', 'wet', 'unused', 'aniso']

export function legacyParts(search) {
  const value = new URLSearchParams(search).get('pbrLegacy')
  if (value === null) return new Set()
  return new Set(value ? value.split(',').filter(part => PBR_PARTS.includes(part)) : PBR_PARTS)
}

export const PBR_LEGACY = import.meta.env?.DEV && typeof location !== 'undefined' ? legacyParts(location.search) : new Set()
