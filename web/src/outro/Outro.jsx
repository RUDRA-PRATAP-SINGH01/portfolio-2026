import { Fragment, useEffect, useRef } from 'react'
import { OUTRO_LENGTH, outro, wipeProgress } from './timeline.js'
import { createReveal, lineAmount, markerAmount } from './content.js'
import './outro.css'

// Placeholder copy from the user's own story (not yet approved): change the words here, nothing else depends on them.
const LINES = ['I had nothing to write on my resume.', 'So I wrote a database.', 'Then a distributed rate limiter.']
const SMALL = 'Rudra Pratap Singh · Backend Engineer · AI Systems'

// The text is only put in once the scene is ready, so its two font files are not fetched before the reveal.
export function Outro({ phase }) {
  const frame = useRef(null)
  const ready = phase === 'ready'
  useEffect(() => {
    if (!ready) return
    const element = frame.current
    const targets = [[element, '--outro-shift'], [element, 'opacity'], [element.querySelector('.outro__small'), '--outro-small'],
      ...[...element.querySelectorAll('.outro__line')].map(line => [line, 'opacity']),
      ...[...element.querySelectorAll('.outro__marker')].map(marker => [marker, '--outro-mark'])]
    const written = []
    const step = createReveal()
    let request = 0, last = 0, grace = 0
    const tick = now => {
      const seconds = last ? Math.min(.1, (now - last) / 1000) : 1 / 60
      last = now
      const { mask, u, still } = step(wipeProgress(outro.eased), seconds)
      // alche also slides each line up 8 px, but on an inline box a transform does nothing, so there is none here.
      const values = [(98.5 - mask * 100).toFixed(3), mask > 0 ? '1' : '0', u.toFixed(4),
        ...LINES.map((_, i) => lineAmount(u, i, LINES.length).toFixed(4)),
        ...LINES.map((_, i) => markerAmount(u, i, LINES.length).toFixed(4))]
      values.forEach((value, i) => {
        if (written[i] !== value) { targets[i][0].style.setProperty(targets[i][1], value); written[i] = value }
      })
      // Rests once nothing moves (a scroll wakes it), so it costs nothing in the forest.
      if (still && outro.eased === outro.target && --grace < 0) { request = 0; last = 0 }
      else request = requestAnimationFrame(tick)
    }
    const wake = () => { grace = 2; if (!request) request = requestAnimationFrame(tick) }
    wake()
    addEventListener('scroll', wake, { capture: true, passive: true })
    return () => { cancelAnimationFrame(request); removeEventListener('scroll', wake, { capture: true }) }
  }, [ready])
  return (
    <section className="outro" style={{ height: `${OUTRO_LENGTH * 100}vh` }} aria-label="About">
      {ready && (
        <div className="outro__frame" ref={frame}>
          <div className="outro__inner">
            <p className="outro__lines">
              {LINES.map((line, i) => (
                <Fragment key={i}><span className="outro__line"><span className="outro__marker">{line}</span> </span><br /></Fragment>
              ))}
            </p>
            <p className="outro__small">{SMALL}</p>
          </div>
        </div>
      )}
    </section>
  )
}
