import * as THREE from 'three/webgpu'

// Where the pointer's view ray meets the ground. The ray is marched over the height map the ground mesh is
// built from (world.heightAt) and refined by bisection: about seventy height lookups per frame, instead of
// testing all 130,000 ground triangles on every pointer event as a mesh raycast does.
// The scroll track (App.jsx) lies over the canvas, so the pointer is followed on the window and measured from
// the canvas's rectangle (an offsetX would be taken in whatever element is under the pointer).
export function createPointerGround(world, element) {
  const ndc = new THREE.Vector2(), origin = new THREE.Vector3(), direction = new THREE.Vector3()
  const { x0, x1, y0, y1 } = world.bounds
  let inside = false
  const onMove = event => {
    const box = element.getBoundingClientRect()
    ndc.set((event.clientX - box.left) / box.width * 2 - 1, 1 - (event.clientY - box.top) / box.height * 2)
    inside = Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1
  }
  // No element to go to: the pointer has left the window (or a touch has ended or turned into a scroll).
  const onOut = event => { if (!event.relatedTarget) inside = false }
  addEventListener('pointermove', onMove, { passive: true })
  addEventListener('pointerout', onOut, { passive: true })
  const above = t => origin.y + direction.y * t - world.heightAt(origin.x + direction.x * t, origin.z + direction.z * t)
  return {
    // Writes the ground point under the pointer into `target`. False when the pointer is off the canvas or
    // its ray leaves the terrain without touching it.
    update(camera, target) {
      if (!inside) return false
      origin.setFromMatrixPosition(camera.matrixWorld)
      direction.set(ndc.x, ndc.y, .5).unproject(camera).sub(origin).normalize()
      if (above(0) <= 0) return false
      // Steps lengthen with distance (a quarter metre at the lens, about ten metres at the far edge).
      for (let near = 0, t = .25, step = .25; t < 140; near = t, step *= 1.1, t += step) {
        if (above(t) > 0) continue
        let far = t
        for (let i = 0; i < 10; i++) { const middle = (near + far) / 2; if (above(middle) > 0) near = middle; else far = middle }
        target.copy(direction).multiplyScalar(far).add(origin)
        return target.x >= x0 && target.x <= x1 && -target.z >= y0 && -target.z <= y1
      }
      return false
    },
    dispose() {
      removeEventListener('pointermove', onMove)
      removeEventListener('pointerout', onOut)
    },
  }
}
