// Builds the ground grid off the main thread (groundMesh.js buildGround), so the loading screen keeps moving.
// In: buildGround's input.  Out: { positions, normals, index, noise } (transferred) or { error }.
import { buildGround } from './groundMesh.js'

self.onmessage = ({ data }) => {
  try {
    const ground = buildGround(data)
    self.postMessage(ground, [ground.positions.buffer, ground.normals.buffer, ground.uvs.buffer, ground.index.buffer, ground.noise?.buffer].filter(Boolean))
  } catch (error) { self.postMessage({ error: error.message }) }
}
