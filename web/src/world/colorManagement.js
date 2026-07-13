import * as THREE from 'three/webgpu'

// These describe the artwork, so they must never depend on UA, DPR or quality.
export const COLOR_SETTINGS = Object.freeze({
  bloomHeight: 450,
  bloomStrength: .38,
  bloomRadius: .35,
  bloomThreshold: 1.1,
  saturation: 1.1,
})

export function configureRendererColor(renderer) {
  THREE.ColorManagement.enabled = true
  THREE.ColorManagement.workingColorSpace = THREE.LinearSRGBColorSpace
  renderer.outputColorSpace = THREE.SRGBColorSpace
  // Exposure and AgX are already baked into the Blender display LUT.
  renderer.toneMapping = THREE.NoToneMapping
  renderer.toneMappingExposure = 1
}

// Two-GPU computers that let a page choose are Macs (Intel MacBook Pros); Chrome ignores the request on Windows, and warns
// about it there (crbug.com/369219127), including in a phone emulation on Windows. three's WebGL2 fallback does not read it.
const MAC = /^mac/i.test(globalThis.navigator?.userAgentData?.platform ?? globalThis.navigator?.platform ?? '')

export async function createForestRenderer(props = {}, forceWebGL = false) {
  const renderer = new THREE.WebGPURenderer({
    ...props, antialias: false, alpha: false,
    powerPreference: MAC ? 'high-performance' : undefined,   // the faster GPU of a two-GPU Mac
    forceWebGL,
    // Keep the preferred 8-bit canvas format; do not request HDR output.
    outputType: undefined,
  })
  configureRendererColor(renderer)
  await renderer.init()
  const context = renderer.getContext()
  if (renderer.backend.isWebGPUBackend) {
    // Older implementations lack getConfiguration; their default is sRGB SDR.
    const config = context.getConfiguration?.()
    if (config) context.configure({ ...config, colorSpace: 'srgb', alphaMode: 'opaque', toneMapping: { mode: 'standard' } })
  } else {
    if ('drawingBufferColorSpace' in context) context.drawingBufferColorSpace = 'srgb'
    if ('unpackColorSpace' in context) context.unpackColorSpace = 'srgb'
  }
  return renderer
}

export function describeColorOutput(renderer) {
  const context = renderer.getContext()
  const gpu = renderer.backend.isWebGPUBackend
  const config = gpu ? context.getConfiguration?.() : null
  return {
    working: THREE.ColorManagement.workingColorSpace,
    output: renderer.outputColorSpace,
    toneMapping: renderer.toneMapping,
    exposure: renderer.toneMappingExposure,
    canvas: gpu ? config?.colorSpace ?? 'srgb' : context.drawingBufferColorSpace ?? 'srgb',
    dynamicRange: gpu ? config?.toneMapping?.mode ?? 'standard' : 'standard',
  }
}
