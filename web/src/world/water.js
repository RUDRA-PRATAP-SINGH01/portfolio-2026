import * as THREE from 'three/webgpu'
import { fetchOk } from './bytes.js'

// Tileable ripple slope maps for the pond (blender/scripts/pack_water.py). RG = (dh/dx, dh/dz), decode v*2-1.
export async function loadWater(entry) {
  if (!entry) return null
  const info = await (await fetchOk('/' + entry.file, { label: 'Water maps' })).json(), loader = new THREE.TextureLoader()
  const load = async path => {
    const t = await loader.loadAsync('/' + path)
    t.colorSpace = THREE.NoColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping
    t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.anisotropy = 8; t.userData.sharedWorld = true
    return t
  }
  const [wind, fine] = await Promise.all([load(info.files.wind), load(info.files.fine)])
  return { wind, fine }
}
