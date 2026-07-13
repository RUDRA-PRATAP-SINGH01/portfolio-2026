import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three/webgpu'
import { cameraPath } from './cameraPath.js'

// A parsed file as GLTFLoader hands it over: a camera, one clip with its position and rotation keys, the extras.
const turn = angle => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), angle).toArray()
const path = cameraPath({
  cameras: [{ name: 'CAM_Scroll' }],
  animations: [new THREE.AnimationClip('scroll', 2, [
    new THREE.VectorKeyframeTrack('CAM_Scroll.position', [0, 1, 2], [0, 1, 0, 2, 1, 0, 2, 1, 4]),
    new THREE.QuaternionKeyframeTrack('CAM_Scroll.quaternion', [0, 1, 2], [...turn(0), ...turn(.5), ...turn(1)]),
  ])],
  scene: { userData: { scroll: { frames: 120, tiara: { frame: 30, look: [0, 2, -1] } } } },
})
const pose = progress => { const p = new THREE.Vector3(), q = new THREE.Quaternion(); path.poseAt(progress, p, q); return { p, q } }
const yaw = q => new THREE.Euler().setFromQuaternion(q, 'YXZ').y

test('the path holds its end poses beyond 0 and 1', () => {
  assert.deepEqual(pose(-1).p.toArray(), [0, 1, 0]); assert.ok(Math.abs(yaw(pose(-1).q)) < 1e-9)
  assert.deepEqual(pose(2).p.toArray(), [2, 1, 4]); assert.ok(Math.abs(yaw(pose(2).q) - 1) < 1e-6)
})

test('between keys the pose is interpolated', () => {
  const { p, q } = pose(.75)                           // halfway between the keys at 1 s and 2 s
  assert.ok(p.distanceTo(new THREE.Vector3(2, 1, 2)) < 1e-9)
  assert.ok(Math.abs(yaw(q) - .75) < 1e-6)
})

test('the tiara pass is in progress units (none in older files)', () => {
  assert.equal(path.frames, 120); assert.equal(path.tiara, .25)
  const older = cameraPath({ cameras: [{ name: 'CAM_Scroll' }], animations: [new THREE.AnimationClip('scroll', 2, [
    new THREE.VectorKeyframeTrack('CAM_Scroll.position', [0, 2], [0, 0, 0, 1, 0, 0]),
    new THREE.QuaternionKeyframeTrack('CAM_Scroll.quaternion', [0, 2], [...turn(0), ...turn(1)]),
  ])], scene: { userData: { scroll: { frames: 120 } } } })
  assert.equal(older.tiara, null)
})
