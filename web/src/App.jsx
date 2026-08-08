import * as THREE from 'three/webgpu'
import { Component, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { loadWorldData } from './world/data.js'
import { Terrain } from './world/Terrain.jsx'
import { Water } from './world/Pond.jsx'
import { Moai } from './world/Moai.jsx'
import { ForestAssets } from './world/ForestAssets.jsx'
import { Lights } from './world/CinematicLights.jsx'
import { Post } from './world/Post.jsx'
import { CameraRig, ORBIT } from './world/CameraRig.jsx'
import { home, scroll, setScroll } from './world/scroll.js'
import { Grass } from './grass/Grass.jsx'
import { Trees } from './trees/Trees.jsx'
import { TIERS, defaultTier } from './quality.js'
import { createLoadingSession } from './loading/progress.js'
import { GRAPHICS_LOST, LoadingScreen } from './loading/LoadingScreen.jsx'
import { SceneReady } from './loading/SceneReady.jsx'
import { registerRenderer } from './world/cinematic.js'
import { AdaptiveQuality } from './world/AdaptiveQuality.jsx'
import { PINNED, bounds } from './world/resolution.js'
import { STATS, StatsProbe, statsText } from './stats.jsx'
import { LightShafts } from './world/LightShafts.jsx'
import { createPointerGround } from './world/pointerGround.js'
import { createForestRenderer, configureRendererColor } from './world/colorManagement.js'
import { createCursor } from './ui/cursor.js'
import { OUTRO_LENGTH, OUTRO_ON, outro, restPoint, trackPlace } from './outro/timeline.js'
import { Outro } from './outro/Outro.jsx'

// Development: ?progress=<0..1> opens the page at that place on the camera's path.
const startAt = import.meta.env.DEV && new URLSearchParams(location.search).get('progress')
if (startAt) setScroll(Number(startAt) || 0, true)
// Development: ?after=<viewports> opens the page that far past the path's end, in the outro (outro/timeline.js).
const startAfter = import.meta.env.DEV && OUTRO_ON && !ORBIT && Number(new URLSearchParams(location.search).get('after'))
if (startAfter > 0) { setScroll(1, true); outro.target = outro.eased = startAfter }
// ?name=0 leaves the name off the opening view (measurements of the scene alone).
const NAME = new URLSearchParams(location.search).get('name') !== '0'

class SceneBoundary extends Component {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error) { this.props.onError(error.message) }
  render() { return this.state.failed ? null : this.props.children }
}

function Scene({ world, tier, session, resetSignal, fpsText, onInfo, onError, onDprChange }) {
  const pointer = useRef({ active: false, point: new THREE.Vector3(), velocity: new THREE.Vector2(), last: null })
  const frames = useRef({ n: 0, t: 0, shown: '' })
  const onReady = useCallback(() => session.report('grass', 1), [session])
  // The fps number, written into the panel's text (a React update re-rendered App, the Canvas and the whole scene
  // twice a second); ?stats also refreshes its readout.
  useFrame((_, dt) => {
    const f = frames.current; f.n++; f.t += dt
    if (f.t <= 0.5) return
    const fps = Math.round(f.n / f.t), text = `${fps} fps`; f.n = 0; f.t = 0
    if (fpsText.current && text !== f.shown) { fpsText.current.textContent = f.shown = text }
    if (STATS) onInfo({ fps })
  })
  // The ground point under the pointer (the grass leans away from it and glows), found once per frame
  // before the grass reads it. No mesh is ray-tested: see pointerGround.js.
  const canvas = useThree(state => state.gl.domElement)
  const ground = useMemo(() => createPointerGround(world, canvas), [world, canvas])
  useEffect(() => () => ground.dispose(), [ground])
  const hit = useMemo(() => new THREE.Vector3(), [])
  useFrame(({ camera }) => {
    const p = pointer.current
    p.velocity.multiplyScalar(0.9)
    if (ground.update(camera, hit)) {
      if (p.last && hit.distanceToSquared(p.last) > 1e-10) p.velocity.set(hit.x - p.last.x, hit.z - p.last.z).multiplyScalar(20)
      p.point.copy(hit); (p.last ??= new THREE.Vector3()).copy(hit); p.active = true
    } else { p.active = false; p.last = null }
  }, -3)
  return (
    <>
      <AdaptiveQuality tier={tier} session={session} onDprChange={onDprChange} />
      <CameraRig world={world} resetSignal={resetSignal} />
      <Lights world={world} />
      <Terrain world={world} />
      <Water world={world} />
      <Moai world={world} url={'/' + world.meta.moai.file} transform={world.meta.moai.matrix} onError={onError} onProgress={session.head} />
      <LightShafts world={world} />
      <ForestAssets world={world} onError={onError} onProgress={session.details} />
      <Grass world={world} tier={tier} pointerRef={pointer} onReady={onReady} onError={onError} />
      <Trees world={world} tier={tier} onError={onError} onProgress={session.trees} />
      <Post world={world} />
      <SceneReady session={session} world={world} />
      {STATS && <StatsProbe />}
    </>
  )
}

export default function App() {
  const [world, setWorld] = useState(null)
  const [session, setSession] = useState(() => createLoadingSession())
  const [phase, setPhase] = useState('loading')
  const [tierKey, setTierKey] = useState(defaultTier)
  const [reset, setReset] = useState(0)
  const [info, setInfo] = useState({})
  const fpsText = useRef(null)
  const renderer = useRef(null)
  // Every visit starts at one dot per point; the sharpness test behind the loading screen may raise it (resolution.js).
  const [renderDpr,setRenderDpr]=useState(() => PINNED ?? bounds(devicePixelRatio).floor)
  const onError = useCallback(message => { session.fail(message); setPhase('error') }, [session])
  const onReveal = useCallback(() => setPhase('revealing'), [])
  const onComplete = useCallback(() => setPhase('ready'), [])
  // The ring that follows the mouse (ui/cursor.js): made once, for a mouse or a trackpad only.
  useEffect(() => { const c = createCursor(); return () => c?.dispose() }, [])
  useEffect(() => {
    if (world) return
    let cancelled = false
    loadWorldData('/data/', session.world).then(value => { if (!cancelled) setWorld(value) })
      .catch(error => { if (!cancelled) onError(error.message) })
    return () => { cancelled = true }
  }, [world, session, onError])
  const changeQuality = event => {
    if (event.target.value === tierKey) return
    setPhase('loading')
    setSession(createLoadingSession({ worldReady: !!world, intro: false }))
    setTierKey(event.target.value)
  }
  const tier = TIERS[tierKey]
  // The scroll track sets the camera's place on the path (scroll.js, which outlives a rebuilt canvas). Nothing
  // scrolls before the scene is ready (loading.css); then the track takes the focus, so the keys scroll it too.
  const track = useRef(null)
  const reducedMotion = useMemo(() => matchMedia('(prefers-reduced-motion: reduce)'), [])
  const back = useRef(null)
  useEffect(() => {
    const element = track.current
    if (!element) return                                                            // ?orbit: no track
    const range = () => element.scrollHeight - element.clientHeight
    // The outro's room follows the path's (outro/Outro.jsx): the path keeps its own length, the outro adds its own.
    const room = element.querySelector('.outro'), spacer = element.querySelector('.scroll-spacer')
    const length = () => room ? spacer.offsetHeight : range(), unit = () => room.offsetHeight / OUTRO_LENGTH
    const instant = () => phase !== 'ready' || reducedMotion.matches
    // Desktop: a scroll that comes to rest inside the outro is carried on to the nearest of its rests (alche's).
    const desk = matchMedia('(pointer: fine) and (min-width: 769px)')
    let timer = 0, tween = 0, held = startAfter > 0                                 // (?after holds there, as __scroll.outro)
    const stop = () => { clearTimeout(timer); cancelAnimationFrame(tween); tween = 0 }
    const glide = (to, done) => {                                                   // 1 s, power3.out
      const from = element.scrollTop, began = performance.now()
      const tick = now => {
        const t = Math.min(1, (now - began) / 1000)
        element.scrollTop = from + (to - from) * (1 - (1 - t) ** 4)
        tween = t < 1 ? requestAnimationFrame(tick) : 0
        if (t === 1) done?.()
      }
      tween = requestAnimationFrame(tick)
    }
    const rest = () => {
      if (tween) return
      clearTimeout(timer)
      if (held || instant() || !desk.matches || !(outro.target > 0)) return
      // As alche's: 0.1 s after the eased page has come to rest (within half a pixel), not the raw scroll, so the
      // notches of a calm wheel (~250 ms apart) are not pulled back between them.
      const settled = () => !scroll.moving && Math.abs(outro.eased - outro.target) * unit() <= .5
      const snap = () => {
        const at = restPoint(outro.target), to = at === null ? null : length() + at * unit()
        if (to !== null && Math.abs(to - element.scrollTop) > 1) glide(to)
      }
      const wait = () => { timer = setTimeout(() => { if (settled()) timer = setTimeout(snap, 100); else wait() }, 16) }
      wait()
    }
    const input = () => { held = false; stop() }                                   // the visitor's own input ends a glide
    const onScroll = () => {
      const top = element.scrollTop, path = length(), at = trackPlace(top, path, room ? unit() : 1)
      if (room) { outro.target = at.after; if (instant() || tween) outro.eased = at.after; rest() }   // (a glide is not eased again)
      // Within half a pixel of the place already set: the rounding of a scrollTop written here, not a scroll.
      // Until the scene shows, and under reduced motion, the camera is put there at once.
      if (Math.abs(Math.min(top, path) - scroll.target * path) > .5) setScroll(at.progress, instant())
    }
    // A new window size changes the track's length: keep the place on the path (or in the outro), not the pixels.
    // After "Back to start" has flown home the page is put at the top.
    const place = () => {
      if (room) outro.ratio = unit() / length()                                    // (the page's one eased place, timeline.js)
      element.scrollTop = outro.target > 0 ? length() + outro.target * unit() : scroll.target * length()
    }
    // "Back to start" from the outro: the page scrolls back up to the path's end (the light going down with it), then home.
    back.current = () => {
      stop()
      if (!(outro.target > 0)) home(reducedMotion.matches)
      else if (reducedMotion.matches) { outro.target = outro.eased = 0; home(true) }
      else glide(length(), () => { outro.target = 0; home() })
    }
    scroll.landed = place
    place()
    if (phase === 'ready') element.focus({ preventScroll: true })
    else { setScroll(scroll.target, true); outro.eased = outro.target }
    element.addEventListener('scroll', onScroll, { passive: true }); addEventListener('resize', place)
    const inputs = room ? ['wheel', 'touchstart', 'keydown', 'pointerdown'] : []
    for (const type of inputs) addEventListener(type, input, { passive: true, capture: true })
    if (import.meta.env.DEV) window.__scroll = {
      set(progress, snap = true) { setScroll(progress, snap); place() },
      // checks: `after` viewports into the outro (held there until the next input), and where it is
      outro(after, snap = true) {
        if (room && after !== undefined) { stop(); held = true; setScroll(1, snap); outro.target = after; if (snap) outro.eased = after; place() }
        return { target: outro.target, eased: outro.eased, wipe: outro.wipe, covered: outro.covered }
      },
      get: () => ({ target: scroll.target, eased: scroll.eased, moving: scroll.moving }),
      // captures: hold a flight's clock at `seconds` since takeoff (null lets it run on)
      at(seconds) { scroll.hold = seconds !== null; if (scroll.flight && seconds !== null) scroll.flight.time = seconds },
    }
    return () => {
      stop(); element.removeEventListener('scroll', onScroll); removeEventListener('resize', place); scroll.landed = null
      for (const type of inputs) removeEventListener(type, input, { capture: true })
    }
  }, [phase, world, reducedMotion])
  const hud = (
    <div className="hud" aria-hidden={phase !== 'ready'}>
      <b>Moai Forest</b><br />
      <span className="performance" ref={fpsText}>– fps</span>
      <select data-cursor="hide" aria-label="Scene quality" value={tierKey} onChange={changeQuality}>
        {Object.entries(TIERS).map(([k, t]) => <option key={k} value={k}>{t.label}</option>)}
      </select>
      {ORBIT ? <button data-cursor="hide" onClick={() => setReset((r) => r + 1)}>Reference view</button> : <button data-cursor="hide" onClick={() => back.current?.()}>Back to start</button>}
      <div className="hint">{ORBIT ? 'Drag to orbit · scroll to explore' : 'Scroll to explore'}</div>
      {STATS && <pre className="stats">{statsText(renderer.current, info, tier.label)}</pre>}
      {STATS && <button data-cursor="hide" onClick={() => navigator.clipboard?.writeText(statsText(renderer.current, info, tier.label))}>Copy readout</button>}
    </div>
  )
  return (
    <>
      <LoadingScreen session={session} onReveal={onReveal} onComplete={onComplete} />
      <main className="experience" data-phase={phase} aria-busy={phase === 'loading'} inert={phase !== 'ready'}>
      <div className="scene-shell">
      <SceneBoundary key={tierKey} onError={onError}>
      <Canvas
        key={tierKey}
        dpr={renderDpr}
        // Measure layout dimensions, so the loading zoom cannot enlarge the
        // render surface and offset the camera after the reveal settles.
        resize={{ offsetSize: true }}
        // no shadow maps (CinematicLights.jsx); an object, not `false`: for a boolean R3F sets PCFSoftShadowMap, which
        // three's WebGPU renderer no longer has and warns about on every new canvas (each change of quality)
        shadows={{ enabled: false, type: THREE.PCFShadowMap }}
        camera={{ fov: 41, near: 0.05, far: 400, position: [0, 1, 0] }}
        gl={async (props) => {
          const forceWebGL = new URLSearchParams(location.search).has('webgl')        // ?webgl tests the WebGL2 fallback path
          let renderer
          try { renderer = await createForestRenderer(props, forceWebGL); registerRenderer(renderer); session.report('renderer', 1) }
          catch (error) { onError(error.message); throw error }
          // A lost device (three already ignores one destroyed on purpose, as on a change of quality): three would
          // only log it, and the page would stand still without a word. The error screen offers the reload instead.
          renderer.onDeviceLost = info => { console.error('Graphics device lost', info); onError(GRAPHICS_LOST) }
          return renderer
        }}
        onCreated={({ gl, scene, camera }) => { configureRendererColor(gl); renderer.current = gl; if (import.meta.env.DEV) window.__forest = { gl, scene, camera } }}
      >
        {world && <Scene world={world} tier={tier} session={session} resetSignal={reset} fpsText={fpsText} onInfo={setInfo} onError={onError} onDprChange={setRenderDpr} />}
      </Canvas>
      </SceneBoundary>
      </div>
      {ORBIT ? hud : (
        // The scroll track (loading.css): ten screens of scrolling over the scene, its position the camera's place on
        // the path. The panel rides in its sticky stage, so the wheel and a finger also scroll over the panel.
        <div className="scroll-track" ref={track} tabIndex={0} role="region" aria-label="The forest: scroll to explore">
          <div className="scroll-stage">
            {/* The name, one word a line, where hatom.com's landing headline stands (loading.css, .name-block). */}
            {NAME && <div className="name-block"><h1 className="name"><span>Rudra </span><span>Pratap </span><span>Singh</span></h1></div>}
            {hud}
          </div>
          <div className="scroll-spacer" />
          {OUTRO_ON && <Outro phase={phase} />}
        </div>
      )}
      </main>
    </>
  )
}
