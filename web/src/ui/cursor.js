// The ring that follows the mouse: unseen.co's cursor (their theme's cursor code, read 2026-11-16).
// A white ring 2.2rem across (their root font size is clamp(14px, 1vw, 38px): 35.2 px on a window 1600 px wide),
// 1.5 px thick, with no fill and no blend mode, trails the pointer. The arrow stays: like theirs, the ring is a
// companion, not a replacement. Each 60 Hz frame it closes 20% of the gap to the pointer, the gap rounded to whole
// pixels first, so it comes to rest instead of creeping forever. While it trails it is stretched along its motion:
// longer by gap / 200 and thinner by as much, at most 0.55 (a gap of 110 px or more). A press shrinks it to 0.8 in
// 0.2 s; over an element marked data-cursor="hide" it shrinks to nothing and fades (0.8 s, their expo.out), and
// grows back on the way out. Here the easing follows the real frame time (identical to theirs at 60 Hz), and once
// the rounded gap is nothing the ring sits exactly on the pointer.
//
// It is the page's only animation outside the canvas, so it must cost nothing when nothing moves: its frame loop
// stops as soon as the ring is hidden or has come to rest, and the next move of the mouse starts it again. Each frame
// writes two transforms on composited layers (loading.css): no layout, no paint.
// It is shown only to a mouse or a trackpad, and only on the finished page: not before the first move (then it
// appears on the pointer, without flying in), not while the pointer is outside the window, not before the page is
// ready, and not during the sharpness test (world/resolution.js), which times the scene behind the loading screen
// while nothing else in the page may draw. Visitors who ask for reduced motion get it on the pointer, unstretched.
// ?cursor=0 leaves it out (measurements and captures that move the mouse).

export const CURSOR = Object.freeze({
  follow: .2,      // of the rounded gap, per 60 Hz frame
  stretch: 200,    // pixels of gap per unit of stretch
  cap: .55,        // the stretch at most
})

/** One frame of the chase, `dt` seconds long: moves `pos` ({ x, y }, in place) toward `mouse` by their 20% of the
 *  rounded gap per 60 Hz frame, by time. Where the gap rounds to nothing the ring is put on the pointer. */
export function followStep(pos, mouse, dt) {
  const k = 1 - (1 - CURSOR.follow) ** (dt * 60)
  const dx = Math.round(mouse.x - pos.x), dy = Math.round(mouse.y - pos.y)
  pos.x = dx ? pos.x + dx * k : mouse.x
  pos.y = dy ? pos.y + dy * k : mouse.y
  return pos
}

/** The stretch for a rounded gap (dx, dy): the direction of motion in degrees, and how much longer along it (and
 *  thinner across it) the ring is drawn. */
export function stretch(dx, dy) {
  return { angle: Math.atan2(dy, dx) * 180 / Math.PI, s: Math.min(Math.hypot(dx, dy) / CURSOR.stretch, CURSOR.cap) }
}

/** Puts the ring in the page, if this visitor has a mouse. Returns { dispose }, or null when it is not made. */
export function createCursor() {
  if (typeof document === 'undefined' || new URLSearchParams(location.search).get('cursor') === '0') return null
  if (!matchMedia('(hover: hover) and (pointer: fine)').matches) return null

  // Outside the scene's shell (the loading reveal scales that), a sibling of #root: under the loading screen, over the
  // panel. The outer element only moves; the ring inside it is turned and stretched (as theirs).
  const el = document.createElement('div'), ring = document.createElement('div')
  el.className = 'cursor'; ring.className = 'cursor-ring'
  el.hidden = true; el.setAttribute('aria-hidden', 'true')
  el.append(ring); document.body.append(el)

  const reduced = matchMedia('(prefers-reduced-motion: reduce)')
  const mouse = { x: 0, y: 0 }, pos = { x: 0, y: 0 }
  let seen = false, shown = false, raf = 0, last = 0
  // The page is finished and no test is timing it (the two attributes are watched, so the ring can appear the
  // moment the reveal ends, under a pointer that is already there).
  const ready = () => document.querySelector('.experience')?.dataset.phase === 'ready' && !document.documentElement.hasAttribute('data-sharpness-test')
  let open = ready()

  const draw = (angle, s) => {
    el.style.translate = `${pos.x}px ${pos.y}px`
    ring.style.transform = s ? `rotate(${angle}deg) scale(${1 + s}, ${1 - s})` : ''
  }
  const stop = () => { if (raf) cancelAnimationFrame(raf); raf = 0; last = 0 }
  const tick = now => {
    raf = 0
    const dt = last ? (now - last) / 1000 : 1 / 60; last = now      // (the first frame after a rest: one 60 Hz frame)
    const dx = Math.round(mouse.x - pos.x), dy = Math.round(mouse.y - pos.y)
    if (reduced.matches) { pos.x = mouse.x; pos.y = mouse.y; draw(0, 0) }
    else { followStep(pos, mouse, dt); const { angle, s } = stretch(dx, dy); draw(angle, s) }
    if (pos.x !== mouse.x || pos.y !== mouse.y || dx || dy) raf = requestAnimationFrame(tick); else last = 0
  }
  const start = () => { if (shown && !raf) raf = requestAnimationFrame(tick) }
  // Shown or hidden as the state asks. It always reappears on the pointer: from wherever it was hidden it would fly in.
  const update = () => {
    const want = seen && open
    if (want === shown) return
    shown = want; el.hidden = !want
    if (want) { pos.x = mouse.x; pos.y = mouse.y; draw(0, 0) } else { stop(); el.removeAttribute('data-pressed') }
  }
  const away = () => { seen = false; update() }

  const onMove = e => {
    if (e.pointerType === 'touch') return away()
    mouse.x = e.clientX; mouse.y = e.clientY
    if (!seen) { seen = true; update() }
    start()
  }
  const onDown = e => { if (e.pointerType === 'touch') away(); else el.setAttribute('data-pressed', '') }
  const onUp = e => { if (e.pointerType === 'touch') away(); else el.removeAttribute('data-pressed') }
  const onOver = e => { el.toggleAttribute('data-over-hide', !!e.target.closest?.('[data-cursor="hide"]')) }
  const onOut = e => { if (!e.relatedTarget) away() }                 // (no element to go to: the pointer left the window)
  const watch = new MutationObserver(() => { open = ready(); update() })
  const main = document.querySelector('.experience')
  if (main) watch.observe(main, { attributes: true, attributeFilter: ['data-phase'] })
  watch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-sharpness-test'] })

  // (capture: nothing in the page can stop an event before the ring hears it)
  const options = { capture: true, passive: true }
  const events = [['pointermove', onMove], ['pointerdown', onDown], ['pointerup', onUp], ['pointercancel', onUp], ['pointerover', onOver], ['pointerout', onOut]]
  for (const [type, listener] of events) addEventListener(type, listener, options)
  return {
    dispose() {
      stop(); watch.disconnect()
      for (const [type, listener] of events) removeEventListener(type, listener, options)
      el.remove()
    },
  }
}
