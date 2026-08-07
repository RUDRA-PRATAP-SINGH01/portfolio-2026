import { useEffect } from 'react'
import { CHAPTERS } from './progress.js'

// The error a lost graphics device reports (App.jsx): a driver reset, or a laptop waking from sleep. The scene
// cannot draw again on its own, so the error screen offers the reload.
export const GRAPHICS_LOST = 'graphics-device-lost'

// The shell lives in index.html so it paints before React, Three or any assets
// arrive. Reuse that DOM instead of replacing it and restarting its animation.
export function LoadingScreen({ session, onReveal, onComplete }) {
  useEffect(() => {
    const screen = document.getElementById('cinematic-loader')
    // The count is written twice: the row that stands above the waterline and its mirror below (loading.css).
    const rows = [...screen.querySelectorAll('[data-load-count]')].map(row => [...row.children])
    const progress = screen.querySelector('[role="progressbar"]')
    const caption = screen.querySelector('[data-load-caption]')
    const message = screen.querySelector('[data-load-message]')
    const retry = screen.querySelector('[data-load-retry]')
    const motion = matchMedia('(prefers-reduced-motion: reduce)')
    let state = session.getSnapshot(), shown = 0, drawn = -1, lastNumber = -1, lastChapter = -2
    let raf, finishTimer, phase = 'loading', completeAt = null, lastTime = performance.now()
    const started = lastTime

    // value: 0 to 100. The line follows it exactly; the figures change with each whole number, and a nought that
    // only fills a place (the 0 of 042) is marked, so the screen can dim it.
    const draw = value => {
      if (value === drawn) return
      drawn = value
      screen.style.setProperty('--load-progress', value / 100)
      const number = Math.floor(value)
      if (number === lastNumber) return
      lastNumber = number
      const figures = String(number).padStart(3, '0'), places = 3 - String(number).length
      rows.forEach(row => row.forEach((figure, i) => {
        if (figure.textContent !== figures[i]) figure.textContent = figures[i]
        figure.toggleAttribute('data-lead', i < places)
      }))
      progress.setAttribute('aria-valuenow', number)
    }

    screen.hidden = false
    screen.dataset.phase = 'loading'
    draw(0)
    caption.textContent = CHAPTERS[0].label
    message.textContent = ''
    retry.hidden = true

    const update = () => {
      state = session.getSnapshot()
      if (state.error) {
        phase = 'error'; screen.hidden = false; screen.dataset.phase = 'error'
        clearTimeout(finishTimer)
        const lost = state.error === GRAPHICS_LOST
        caption.textContent = lost ? 'The forest stopped drawing.' : 'The forest couldn’t finish loading.'
        message.textContent = lost ? 'Your graphics chip was reset. Try again to start it afresh.' : 'Check your connection, then try again.'
        // The button takes the focus: it is the one thing to do now, and a screen reader then reads the message
        // with it (aria-describedby in index.html).
        retry.hidden = false; retry.focus({ preventScroll: true })
      } else if (lastChapter !== state.chapter) {
        lastChapter = state.chapter
        caption.textContent = state.ready ? 'Your journey begins' : CHAPTERS[state.chapter].label
      }
    }
    const unsubscribe = session.subscribe(update)
    update()

    const tick = now => {
      if (phase === 'error' || phase === 'complete') return
      const dt = Math.min(now - lastTime, 80); lastTime = now
      if (shown !== state.progress) {
        shown += (state.progress - shown) * (1 - Math.exp(-dt / (motion.matches ? 30 : 240)))
        // Arrive, rather than close in for ever: a count that has stopped must leave nothing to redraw.
        if (state.progress - shown < .05 || (state.ready && shown > 99.6)) shown = state.progress
        // While the sharpness test times the scene behind this screen (world/resolution.js, up to three seconds
        // on a slow chip) the count moves in whole numbers only, a few times a second. Following it frame by
        // frame would have the browser draw this screen sixty times a second in the middle of the measurement.
        draw(document.documentElement.hasAttribute('data-sharpness-test') ? Math.floor(shown) : shown)
      }
      if (state.ready && shown === 100 && completeAt === null) completeAt = now
      const minimum = motion.matches ? 0 : session.intro ? 2200 : 400
      const hold = motion.matches ? 0 : 400
      if (phase === 'loading' && completeAt !== null && now - started >= minimum && now - completeAt >= hold) {
        phase = 'revealing'; screen.dataset.phase = 'revealing'
        onReveal()
        // The cut's length is loading.css's --cut (the panels' slide, or the reduced-motion dissolve): one place.
        const cut = getComputedStyle(screen).getPropertyValue('--cut').trim()
        finishTimer = setTimeout(() => {
          phase = 'complete'; screen.dataset.phase = 'complete'; screen.hidden = true
          onComplete()
        }, cut.endsWith('ms') ? parseFloat(cut) : parseFloat(cut) * 1000)
      }
      if (!state.ready && now - started > 20000 && !message.textContent) message.textContent = 'The forest is taking a little longer to wake.'
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => { unsubscribe(); cancelAnimationFrame(raf); clearTimeout(finishTimer) }
  }, [session, onReveal, onComplete])
  return null
}
