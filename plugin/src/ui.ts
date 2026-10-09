// Phone companion page (the WebView itself). Mirrors what the glasses show
// and offers on-screen controls, which double as the push-to-talk fallback in
// the simulator, where long-press isn't available.

import type { Gesture } from './glasses/input'
import type { Frame } from './render/screens'

type Status = 'connecting' | 'ready' | 'error'

let statusEl: HTMLDivElement
let mirrorEls: Record<keyof Frame, HTMLDivElement>

export function mountUi(onGesture: (g: Gesture) => void) {
  const app = document.querySelector<HTMLDivElement>('#app')!
  app.innerHTML = `
    <main class="panel">
      <header>
        <h1>Wingman</h1>
        <div id="status" class="status status-connecting">Connecting…</div>
      </header>
      <section class="mirror" aria-label="What the glasses show">
        <div id="m-header" class="m-dim"></div>
        <div id="m-body"></div>
        <div id="m-footer" class="m-dim"></div>
      </section>
      <section class="controls">
        <button data-g="up" aria-label="Up">▲</button>
        <button data-g="tap">Select</button>
        <button data-g="down" aria-label="Down">▼</button>
        <button data-g="double">Back</button>
        <button id="talk" class="talk">Hold to talk</button>
      </section>
      <footer>Ring or temple: swipe to move, tap to open, hold to talk, double-tap to go back.</footer>
    </main>
  `
  statusEl = app.querySelector('#status')!
  mirrorEls = {
    header: app.querySelector('#m-header')!,
    body: app.querySelector('#m-body')!,
    footer: app.querySelector('#m-footer')!,
  }
  app.querySelectorAll<HTMLButtonElement>('button[data-g]').forEach(b =>
    b.addEventListener('click', () => onGesture(b.dataset.g as Gesture)),
  )
  const talk = app.querySelector<HTMLButtonElement>('#talk')!
  let holding = false
  const start = (e: Event) => {
    e.preventDefault()
    if (holding) return
    holding = true
    talk.classList.add('active')
    onGesture('holdStart')
  }
  const end = () => {
    if (!holding) return
    holding = false
    talk.classList.remove('active')
    onGesture('holdEnd')
  }
  talk.addEventListener('pointerdown', start)
  talk.addEventListener('pointerup', end)
  talk.addEventListener('pointerleave', end)
  talk.addEventListener('pointercancel', end)
  injectStyles()
}

export function setStatus(kind: Status, text: string) {
  if (!statusEl) return
  statusEl.className = `status status-${kind}`
  statusEl.textContent = text
}

export function mirror(frame: Frame) {
  if (!mirrorEls) return
  for (const k of Object.keys(mirrorEls) as (keyof Frame)[]) mirrorEls[k].textContent = frame[k]
}

function injectStyles() {
  // ER brand dark-theme surfaces: #232323 / #2E2E2E / #3E3E3E.
  // ER OS green (#3CFA44) + signal red (#FF453A) for state chips.
  const css = `
    :root { color-scheme: dark; }
    html, body { margin: 0; height: 100%; background: #232323; color: #E5E5E5;
      font: 16px/1.4 -apple-system, BlinkMacSystemFont, 'Helvetica Neue', system-ui, sans-serif;
      touch-action: manipulation; -webkit-text-size-adjust: 100%; overscroll-behavior: none; }
    #app { display: flex; min-height: 100%; }
    .panel { display: flex; flex-direction: column; gap: 16px;
      width: 100%; max-width: 640px; margin: 0 auto; padding: 24px 16px; box-sizing: border-box; }
    header { display: flex; align-items: center; justify-content: space-between; }
    h1 { font-size: 18px; font-weight: 600; margin: 0; letter-spacing: 0.02em; }
    .status { font-size: 12px; padding: 4px 10px; border-radius: 999px;
      border: 1px solid transparent; letter-spacing: 0.04em; text-transform: uppercase; }
    .status-connecting { color: #A7A7A7; border-color: #3E3E3E; }
    .status-ready { color: #3CFA44; border-color: #3CFA44; background: rgba(60,250,68,0.08); }
    .status-error { color: #FF453A; border-color: #FF453A; background: rgba(255,69,58,0.08); }
    .mirror { background: #000; border: 1px solid #3E3E3E; border-radius: 12px; padding: 12px 14px;
      color: #3CFA44; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
      white-space: pre-wrap; word-break: break-word; min-height: 200px; }
    .mirror .m-dim { opacity: 0.55; }
    #m-body { margin: 8px 0; min-height: 150px; }
    .controls { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
    .controls button { background: #2E2E2E; color: #E5E5E5; border: 1px solid #3E3E3E;
      border-radius: 10px; padding: 12px 0; font: inherit; }
    .controls button:active { background: #3E3E3E; }
    .controls .talk { grid-column: 1 / -1; padding: 18px 0; color: #3CFA44; border-color: #3CFA44;
      user-select: none; -webkit-user-select: none; }
    .controls .talk.active { background: rgba(60,250,68,0.15); }
    footer { font-size: 12px; color: #7B7B7B; text-align: center; }
  `
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
}
