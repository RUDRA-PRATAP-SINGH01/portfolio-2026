import * as THREE from 'three/webgpu'

// For work that depends on what the camera sees (visibility lists built on the CPU).
// With eased camera motion the camera matrix differs on almost every frame, long after the movement has
// stopped being visible, so "has the matrix changed" re-does that work constantly. viewChange() reports a
// change only once the camera has moved further than `distance` or turned more than `angle` since the pose
// it last reported (or its projection changed). Callers build their lists for a view widened by the same
// slack (widenedView), so the lists stay valid in between.
export function viewChange(distance, angle) {
  const position = new THREE.Vector3(Infinity, 0, 0), quaternion = new THREE.Quaternion(), projection = new Float64Array(16).fill(NaN)
  return camera => {
    const elements = camera.projectionMatrix.elements
    let changed = position.distanceToSquared(camera.position) > distance * distance || quaternion.angleTo(camera.quaternion) > angle
    for (let i = 0; i < 16 && !changed; i++) changed = projection[i] !== elements[i]
    if (changed) { position.copy(camera.position); quaternion.copy(camera.quaternion); projection.set(elements) }
    return changed
  }
}

// View-projection matrix of the camera with its field of view opened by `angle` on every side.
// Returns the horizontal and vertical projection scales of the widened view (clip units per metre at w = 1).
export function widenedView(camera, angle, target) {
  const p = target.copy(camera.projectionMatrix).elements
  const sx = p[0] = 1 / Math.tan(Math.atan(1 / p[0]) + angle), sy = p[5] = 1 / Math.tan(Math.atan(1 / p[5]) + angle)
  target.multiply(camera.matrixWorldInverse)
  return { sx, sy }
}
