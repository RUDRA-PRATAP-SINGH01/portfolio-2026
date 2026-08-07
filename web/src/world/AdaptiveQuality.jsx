import { useCallback, useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { motionTime, motionEnabled } from './animation.js'
import { PINNED, RESOLUTION, bounds, decide, fitScale, gpuFinished, levelRatio, lowScale, nextLevel, resolution, startLevel } from './resolution.js'
import { warmup } from '../loading/warmup.js'
import { scroll } from './scroll.js'
import { outro } from '../outro/timeline.js'

// reflectionScale: the pond's mirror resolution relative to the canvas. The pond blurs it through mipmaps,
// so it degrades softly; reflectionHz only applies while the camera is still (it renders every frame in motion).
// shown: the canvas is on screen (the loading screen has begun to open); ready: the loading screen has gone.
export const adaptive = { level: 0, reflectionScale: .5, reflectionHz: 15, foliageScale: 1, shown: false, ready: false, p90: 0 }
// dpr: the level's factor on the visit's sharpness (resolution.js); the ratio never goes under half the floor.
// A visit whose chip was too slow at the floor starts at a lighter level and never goes back above it
// (resolution.minLevel).
const levels = [
  { dpr: 1, reflectionScale: .5, reflectionHz: 15, foliageScale: 1 },
  { dpr: 1, reflectionScale: .4, reflectionHz: 10, foliageScale: .9 },
  { dpr: .85, reflectionScale: .33, reflectionHz: 8, foliageScale: .75 },
  { dpr: .7, reflectionScale: .28, reflectionHz: 6, foliageScale: .55 },
  { dpr: .55, reflectionScale: .25, reflectionHz: 5, foliageScale: .4 },
]
const FIXED = new URLSearchParams(globalThis.location?.search ?? '').has('fixedQuality')
// The ratio drawn at a level: the visit's sharpness (the floor until the test is done) times the level's factor.
const ratioFor = level => PINNED ?? levelRatio(bounds(devicePixelRatio), resolution.kind, levels[level].dpr, resolution.scale)

export function AdaptiveQuality({ tier, session, onDprChange }) {
  const setDpr = useThree(s=>s.setDpr), gl = useThree(s=>s.gl)
  const state = useRef({ samples: [], age: 0, time: 0, reduced: false, memo: {}, settle: 0, calm: 0, page: null, test: {} })
  const draw = useCallback(ratio => { setDpr(ratio); onDprChange(ratio) }, [setDpr, onDprChange])
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => { state.current.reduced=media.matches; motionEnabled.value=media.matches?0:1 }
    update(); media.addEventListener('change',update)
    const initial = Math.max(resolution.minLevel, tier.level)
    Object.assign(adaptive,levels[initial],{level:initial,ready:false})
    draw(ratioFor(initial))
    // A new devicePixelRatio (browser zoom, another monitor): the same choice, worked out again for it, on every
    // resize as hatom does, and when the screen's ratio changes without one (a window moved to another monitor).
    let screen = null
    const rescale = () => {
      const ratio = ratioFor(adaptive.level)
      if (!resolution.measuring && ratio !== gl.getPixelRatio()) draw(ratio)
      screen?.removeEventListener('change', rescale); screen = matchMedia(`(resolution: ${devicePixelRatio}dppx)`); screen.addEventListener('change', rescale)
    }
    rescale(); addEventListener('resize', rescale)
    return () => { media.removeEventListener('change',update); removeEventListener('resize', rescale); screen.removeEventListener('change', rescale) }
  },[tier,draw,gl])

  // The sharpness test (resolution.js), drawn behind the loading screen once the warm-up is done: the cap with the
  // moving-pointer load (Pond.jsx and Post.jsx read resolution.measuring), then the floor if the cap was too slow
  // (or at once, where the floor is all the screen has), then a lower ratio if the floor was far too slow.
  // Each is drawn for a few frames to settle (new render targets); then, frame by frame, the time the graphics
  // chip finishes it is noted, for 0.6 s and at least 12 refreshes (6, when the answer is already plain).
  // The mean time between finished frames is the cost. The loading screen draws no frame of its own meanwhile
  // (loading.css, LoadingScreen.jsx): its count only steps in whole numbers, a few times a second. A screen
  // that animates behind the test is timed with it; the blurs of an earlier one cost the Intel chip 4 to 7 ms a frame.
  // (Holding frames back until the chip catches up was tried: the chip's "finished" signal arrives a few
  // milliseconds late, so the chip sat idle and the frames timed 25 ms where it needs 13.)
  const test = now => {
    const t = state.current.test, { floor, cap } = bounds(devicePixelRatio)
    const finish = (kind, scale = 1) => {
      const minLevel = startLevel(t.floorMs ?? null)
      Object.assign(resolution, { kind, scale, minLevel, measuring: false, settled: !t.began, results: { kind, floor, cap, scale, minLevel,
        capMs: t.capMs ?? null, floorMs: t.floorMs ?? null, lowMs: t.lowMs ?? null, tried: t.tried ?? null,
        seconds: t.began ? (now - t.began) / 1000 : 0, backlog: t.first ? (t.first - t.began) / 1000 : 0 } })
      document.documentElement.removeAttribute('data-sharpness-test')
      const level = Math.max(adaptive.level, minLevel)
      Object.assign(adaptive, levels[level], { level })
      draw(ratioFor(level))
      // The test kept the chip a second or so of frames ahead. The loading session hears that the test is done
      // when the chip has finished them (the frame callback below), so the screen does not open onto that queue.
      if (t.began) gpuFinished(gl).then(() => { resolution.settled = true })
      if (import.meta.env.DEV) window.__resolution = { ...resolution.results, ratio: ratioFor(adaptive.level) }
    }
    const begin = (phase, ratio) => { Object.assign(t, { phase, phaseBegan: now, id: (t.id ?? 0) + 1, frames: 0, done: [], enough: false }); draw(ratio) }
    if (PINNED) return finish('pinned')
    if (!warmup.done) return
    if (!t.phase) {
      Object.assign(t, { began: now, restarts: 0 }); resolution.measuring = true
      document.documentElement.setAttribute('data-sharpness-test', '')
      return cap > floor ? begin('cap', cap) : begin('floor', floor)   // (one dot per point may be all the screen has)
    }
    // Only a callback after which a frame was drawn counts: Post.jsx holds frames back while the chip is far behind.
    const drew = warmup.drawn !== t.seen; t.seen = warmup.drawn
    if (drew && ++t.frames > RESOLUTION.settleFrames && !t.enough) {
      const id = t.id
      gpuFinished(gl).then(() => {
        if (t.id !== id || t.enough) return
        const at = performance.now(), done = t.done
        // A gap (the tab was hidden, the machine stalled) spoils the timing: start the phase again, twice at most.
        if (done.length && at - done[done.length - 1] > 1000 && t.restarts < 2) { t.restarts++; t.done = []; return }
        done.push(at); t.first ??= at                                   // (first: the warm-up's frames are all drawn)
        const mean = done.length > 1 ? (at - done[0]) / (done.length - 1) / RESOLUTION.repeat : 0
        // Plain answers: far from the budget at the cap; at the floor, far faster than the cap or no faster at all,
        // and far from the time that asks for a lower ratio; at the lower ratio, far faster than the floor or no faster.
        const apart = (ms, from) => ms < from * .8 || ms > from * .98
        const plain = done.length > RESOLUTION.plainFrames && (t.phase === 'cap' ? mean > RESOLUTION.budgetMs * 1.3 || mean < RESOLUTION.budgetMs * .6
          : t.phase === 'floor' ? (t.capMs == null || apart(mean, t.capMs)) && (mean < RESOLUTION.lowMs * .75 || mean > RESOLUTION.lowMs * 1.3)
          : apart(mean, t.floorMs))
        // A chip several times too slow has answered after a few frames, and each of its frames is long.
        const hopeless = done.length > 3 && (t.phase === 'cap' ? mean > RESOLUTION.budgetMs * 2.5 : t.phase === 'floor' && mean > RESOLUTION.lowMs * 2 && (t.capMs == null || apart(mean, t.capMs)))
        t.enough = plain || hopeless || (done.length > RESOLUTION.minFrames && at - done[0] >= RESOLUTION.measureSeconds * 1000)
      })
    }
    // The loading screen's count keeps moving through the test. How long each half takes is not known ahead (a
    // fast chip needs a tenth of a second, a slow one a second and a half), so the share reported closes in on
    // the end of its part without reaching it: the cap up to .3, the floor from .33 up to .63, the lower ratio from
    // .66 up to .95 (in twentieths, so the loading session has news a few times a second, not every frame).
    const part = { cap: 0, floor: .33, low: .66 }
    const since = (now - t.phaseBegan) / 1000, share = part[t.phase] + .29 * (1 - Math.exp(-since / .8))
    if (!t.enough) return void session.report('resolution', Math.floor(share * 20) / 20)
    const ms = (t.done[t.done.length - 1] - t.done[0]) / (t.done.length - 1) / RESOLUTION.repeat     // per frame drawn
    if (t.phase === 'cap') {
      t.capMs = ms
      if (decide({ capMs: ms }) === 'cap') return finish('cap')
      begin('floor', floor); session.report('resolution', part.floor)
      return
    }
    if (t.phase === 'floor') {
      t.floorMs = ms
      const verdict = decide({ capMs: t.capMs ?? null, floorMs: ms })
      if (verdict !== 'measure-low') return finish(verdict)
      // The lower ratio is timed at the lighter level the visit will have (its pond reflection is drawn less often
      // under a moving pointer, and from level 3 there is no cursor liquid), so that no more sharpness is given
      // away than that level needs.
      const level = Math.max(adaptive.level, startLevel(ms))
      Object.assign(adaptive, levels[level], { level })
      t.tried = lowScale(ms); begin('low', floor * t.tried); session.report('resolution', part.low)
      return
    }
    t.lowMs = ms
    const scale = fitScale({ floorMs: t.floorMs, lowMs: ms, scale: t.tried })
    // Not faster with fewer pixels and a lighter level: the sharpness the screen had stays.
    if (scale === null) finish(t.capMs != null ? 'cap' : 'floor'); else finish('low', scale)
  }

  useFrame((_,dt) => {
    const s=state.current
    s.time += Math.min(dt,.05); motionTime.value=s.reduced?0:s.time
    if(import.meta.env.DEV) window.__cinematicMotion={time:motionTime.value,enabled:motionEnabled.value}
    const phase=(s.page??=document.querySelector('.experience'))?.dataset.phase, ready=phase==='ready'
    adaptive.ready=ready; adaptive.shown=ready||phase==='revealing'
    if (!ready) { if (!resolution.kind) test(performance.now()); else if (resolution.settled) session.report('resolution', 1); return }
    if (document.hidden || FIXED) return
    // The first second after a change of level is not judged: buffers are being resized and lists rebuilt.
    if (s.settle>0) { s.settle-=dt; return }
    // Nor are the frames while the camera moves along its path (scroll.js) and the half second after: they carry the
    // work of getting the grass and leaves ready for the way ahead, and would lower the quality of the view it rests on.
    if (scroll.moving) { s.calm=.5; return }
    // Nor the outro's (outro/timeline.js): covered by the light the scene is not drawn, and its frames say nothing of it.
    if (outro.target>0 || outro.eased>0) { s.calm=.5; return }
    if (s.calm>0) { s.calm-=dt; return }
    s.age+=dt
    if (dt<.2) s.samples.push(dt*1000)
    if (s.age<4 || s.samples.length<60) return
    const sorted=s.samples.sort((a,b)=>a-b), p90=sorted[Math.floor(sorted.length*.9)], now=performance.now()
    const mean=sorted.reduce((sum,ms)=>sum+ms,0)/sorted.length
    adaptive.p90=p90
    // The rule (steps, trials, waits) is resolution.js nextLevel; it is tested there.
    const decision=nextLevel({ level:adaptive.level, minLevel:resolution.minLevel, top:levels.length-1, p90, mean, now, memo:s.memo })
    const next=decision.level; s.memo=decision.memo
    if (next!==adaptive.level) {
      Object.assign(adaptive,levels[next],{level:next})
      draw(ratioFor(next)); s.settle=1
    }
    s.samples=[];s.age=0
    if(import.meta.env.DEV) window.__adaptive={...adaptive,mean,reducedMotion:s.reduced}
  },-2)
  return null
}
