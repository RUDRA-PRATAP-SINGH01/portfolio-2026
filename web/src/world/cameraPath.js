// The scroll camera's path: animated in Blender (blender/scripts/camera_scroll.py), sampled there on every frame,
// and only played back here by scroll position, as hatom.com does it.
// The file holds one camera node at the scene's root, in three.js axes, with a position and a rotation key on every
// frame, and in the scene's extras the frame where it passes closest to the tiara:
//   scenes[0].extras.scroll = { frames, tiara: { frame, look } }   (frames; look: the look-at point, three.js axes)
// The keys are read through the tracks' own interpolants (what AnimationMixer does inside): any place on the path
// can be asked for, also one ahead of the camera, and both ends hold their pose.
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { download } from './bytes.js'

export const CAMERA_PATH = '/scene/camera_path.glb'
// The opening: the first 1.5% of the path, where the page's name belongs (main[data-opening], CameraRig.jsx).
export const OPENING = .015

/** The path of a parsed file.
 *    poseAt(progress, position, quaternion)  writes the camera's world pose at progress 0..1 (clamped)
 *    tiara   the progress closest to the tiara (null in older files)        frames  the number of sampled steps */
export function cameraPath(gltf) {
  const camera = gltf.cameras[0], clip = gltf.animations[0], info = gltf.scene.userData.scroll
  const track = property => {
    const found = clip.tracks.find(t => t.name === `${camera.name}.${property}`)
    if (!found) throw new Error(`The camera path has no ${property} keys`)
    return found
  }
  const position = track('position'), turn = track('quaternion'), duration = position.times[position.times.length - 1]
  const place = position.createInterpolant(), turned = turn.createInterpolant()
  return {
    frames: info.frames,
    tiara: info.tiara ? info.tiara.frame / info.frames : null,
    poseAt(progress, toPosition, toQuaternion) {
      const time = Math.min(1, Math.max(0, progress)) * duration
      toPosition.fromArray(place.evaluate(time)); toQuaternion.fromArray(turned.evaluate(time))
    },
  }
}

export async function loadCameraPath(url = CAMERA_PATH) {
  const bytes = await download(url, { label: 'Camera path' })
  return cameraPath(await new GLTFLoader().parseAsync(bytes, url.slice(0, url.lastIndexOf('/') + 1)))
}
