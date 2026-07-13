// Dispose shared GLTF resources exactly once, including textures shared by meshes.
export function disposeObject(root) {
  const geometries = new Set(), materials = new Set(), textures = new Set()
  root?.traverse((object) => {
    if (object.geometry) geometries.add(object.geometry)
    for (const material of object.material ? [object.material].flat() : []) {
      materials.add(material)
      Object.values(material).forEach((value) => { if (value?.isTexture) textures.add(value) })
    }
    if (object.isInstancedMesh) object.dispose()
  })
  geometries.forEach((item) => item.dispose())
  materials.forEach((item) => item.dispose())
  textures.forEach((item) => { if(!item.userData.sharedWorld) item.dispose() })
}
