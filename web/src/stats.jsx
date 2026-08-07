// ?stats: what this device is doing, shown on the page itself, to read on a machine with no developer tools open
// (a visitor's laptop): the drawing backend and why, the graphics chip, the browser, the sizes, the sharpness
// test's timings (world/resolution.js), and the frame rates since the scene opened. "Copy readout" in the panel
// (App.jsx) puts the same text on the clipboard. Nothing here runs without the flag.
import { useEffect, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { adaptive } from './world/AdaptiveQuality.jsx'
import { resolution } from './world/resolution.js'
import { WEBGPU } from './quality.js'
import { scroll } from './world/scroll.js'

const query = new URLSearchParams(location.search)
export const STATS = query.has('stats')

// Asked for once. adapter: whether the browser has WebGPU for this chip (quality.js), which says why a visit is on WebGL2.
const facts = { chip: null, adapter: WEBGPU ? 'offered' : navigator.gpu ? 'offered, but not for this chip' : 'not offered by this browser', battery: null, opened: null }
if (STATS) navigator.getBattery?.().then(battery => { facts.battery = battery }, () => {})

function chip(gl) {
  if (facts.chip) return facts.chip
  const info = gl.backend?.device?.adapterInfo, parts = info ? [info.vendor, info.architecture, info.description || info.device].filter(Boolean) : []
  try {
    const probe = document.createElement('canvas').getContext('webgl'), names = probe?.getExtension('WEBGL_debug_renderer_info')
    if (names) parts.push(probe.getParameter(names.UNMASKED_RENDERER_WEBGL))
    probe?.getExtension('WEBGL_lose_context')?.loseContext()
  } catch { /* the name is only for the readout */ }
  return (facts.chip = parts.join(' | ') || 'unknown')
}

// Since the scene opened (the first three seconds left out: the last leaves are still arriving). still, moving:
// frames and seconds in half-second stretches without and with motion (a pointer move, or the camera still
// travelling after a scroll); script: the time one frame's callbacks take on the main thread (everything this page
// does for a frame, the drawing calls included; not the graphics chip's own work).
const live = { since: null, script: 0, lowest: null, still: { frames: 0, seconds: 0 }, moving: { frames: 0, seconds: 0 } }
const restart = () => Object.assign(live, { since: null, script: 0, lowest: null, still: { frames: 0, seconds: 0 }, moving: { frames: 0, seconds: 0 } })

/** Inside the canvas, only with ?stats: times the frame loop from its first callback to its last. */
export function StatsProbe() {
  const clock = useRef({ began: 0, script: 0, frames: 0, start: 0, moved: -Infinity })
  useEffect(() => {
    const move = () => { clock.current.moved = performance.now() }
    addEventListener('pointermove', move, { passive: true })
    return () => removeEventListener('pointermove', move)
  }, [])
  useFrame(() => { clock.current.began = performance.now() }, -1e6)
  useFrame(() => {
    const c = clock.current, now = performance.now()
    if (adaptive.shown) facts.opened ??= now
    if (!adaptive.ready) { if (live.since !== null) restart(); c.start = 0; return }
    live.since ??= now
    if (!c.start) Object.assign(c, { start: now, script: 0, frames: 0 })
    if (scroll.moving) c.moved = now                    // the camera travelling the path is a moving frame too
    c.script += now - c.began; c.frames++
    const seconds = (now - c.start) / 1000
    if (seconds < .5) return
    // A stretch with a gap in it (the tab was hidden) is not counted.
    if (seconds < 1.5 && now - live.since > 3000) {
      const part = c.moved >= c.start ? live.moving : live.still
      part.frames += c.frames; part.seconds += seconds
      live.lowest = Math.min(live.lowest ?? Infinity, c.frames / seconds)
    }
    live.script = c.script / c.frames
    Object.assign(c, { start: now, script: 0, frames: 0 })
  }, 1e6)
  return null
}

export function statsText(gl, info, tierLabel) {
  if (!gl) return 'starting'
  const canvas = gl.domElement, r = resolution.results, battery = facts.battery
  const ms = value => value == null ? '-' : value.toFixed(1) + ' ms'
  const fps = part => part.seconds > 0 ? Math.round(part.frames / part.seconds) + ' fps' : '-'
  const webgpu = !!gl.backend?.isWebGPUBackend
  return [
    `backend   ${webgpu ? 'WebGPU' : 'WebGL2 (' + (query.has('webgl') ? 'asked for with ?webgl' : 'WebGPU ' + facts.adapter) + ')'}`,
    `chip      ${chip(gl)}`,
    `browser   ${navigator.userAgent}`,
    `machine   ${navigator.hardwareConcurrency ?? '?'} threads, ${navigator.deviceMemory ?? '?'} GB${battery ? `, ${battery.charging ? 'plugged in' : 'on battery'} ${Math.round(battery.level * 100)}%` : ''}`,
    `window    ${innerWidth} x ${innerHeight} at ${devicePixelRatio.toFixed(2)}`,
    `drawn     ${canvas.width} x ${canvas.height} (ratio ${gl.getPixelRatio().toFixed(2)})`,
    `test      ${r ? `${r.kind}${r.kind === 'low' ? ' ' + r.scale : ''}, cap ${ms(r.capMs)}, floor ${ms(r.floorMs)}, lower ${ms(r.lowMs)}${r.tried ? ' at ' + r.tried : ''}, took ${r.seconds.toFixed(1)} s` : 'not run'}`,
    `loading   opened after ${facts.opened ? (facts.opened / 1000).toFixed(1) + ' s' : '-'}`,
    `now       ${info.fps ?? '-'} fps, script ${live.script ? live.script.toFixed(1) + ' ms a frame' : '-'}, level ${adaptive.level} (from ${resolution.minLevel}), ${tierLabel}`,
    `since     still ${fps(live.still)}, moving (pointer or scroll) ${fps(live.moving)}, lowest ${live.lowest ? Math.round(live.lowest) + ' fps' : '-'}, 90% of frames within ${ms(adaptive.p90 || null)}`,
  ].join('\n')
}
