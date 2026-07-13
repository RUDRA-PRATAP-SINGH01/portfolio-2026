// What `three` means for every package (vite.config.js): three's WebGPU build, so all share one copy. React Three
// Fiber also names the classic WebGLRenderer, for a canvas given no renderer of its own; App.jsx always gives one
// (WebGPURenderer, which carries its own WebGL2 fallback), so that path never runs.
export * from 'three/webgpu'
export class WebGLRenderer {
  constructor() { throw new Error('WebGLRenderer is not part of this build: pass a WebGPURenderer (App.jsx)') }
}
