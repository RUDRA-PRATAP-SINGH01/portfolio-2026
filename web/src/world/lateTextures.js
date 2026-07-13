import { ktx2Loader } from './cinematic.js'
import { TEXTURES_LOW } from '../quality.js'

// Desktop textures with a phone twin load the twin before the reveal and the desktop file once the scene is showing
// and the near leaves have taken over (A4, 2026-11-18: 4.4 MB less before the reveal). The swap is in place: the
// twin's Texture object keeps every setting and every shader node that samples it and takes the larger file's mip
// chain; dispose() drops only its GPU texture and the bind groups that point to it, so the renderer makes a new one
// on the next frame (three r187) and nothing recompiles. Phones keep their twins.
// Development: ?late=0 loads the desktop files before the reveal (as before), ?late=hold keeps the twins.
export function lateMode(search) {
  const value = new URLSearchParams(search).get('late')
  return value === '0' ? 'off' : value === 'hold' ? 'hold' : 'on'
}

const MODE = TEXTURES_LOW ? 'off' : import.meta.env?.DEV && typeof location !== 'undefined' ? lateMode(location.search) : 'on'
export const LATE = MODE !== 'off'

const queue = [], holds = new Set(), state = { queue, swapped: 0, finished: null }
if (import.meta.env?.DEV) globalThis.__late = state           // for the checks in scripts/perf

// `busy()` true holds the downloads back (the near leaves: their own arrival comes first). Returns the release.
export function holdLate(busy) {
  holds.add(busy)
  return () => holds.delete(busy)
}

// `low` is the loaded twin, `url` the desktop file. Returns the twin.
export function upgradeTexture(low, url) {
  if (MODE !== 'on') return low
  queue.push({ low, url })
  timer ??= setInterval(tick, 200)
  return low
}

let timer = null, running = false
const allowed = () => document.querySelector('.experience')?.dataset.phase === 'ready' && ![...holds].some(busy => busy())

function tick() {
  if (running || !allowed()) return
  if (queue.every(item => item.done)) { clearInterval(timer); timer = null; return }
  run()
}

// One file at a time, each swapped on a frame of its own. A change of quality (phase 'loading') pauses the queue.
async function run() {
  running = true
  const loader = await ktx2Loader()
  for (let item; allowed() && (item = queue.find(i => !i.done));) {
    let high
    try { high = await loader.loadAsync(item.url) } catch (error) { console.warn('Desktop texture unavailable, kept the twin:', item.url, error); item.done = true; continue }
    await new Promise(resolve => requestAnimationFrame(resolve))
    swap(item, high)
  }
  if (queue.every(item => item.done)) state.finished = performance.now()
  running = false
}

function swap(item, high) {
  const { low } = item
  item.done = true
  if (high.format !== low.format) { console.warn('Desktop texture in another format, kept the twin:', item.url); return }
  low.dispose()
  low.image = high.image; low.mipmaps = high.mipmaps
  low.needsUpdate = true
  state.swapped++
}
