// Line-art icons for the glasses, drawn on a canvas and sent as PNG.
// White = lit green on the G2; black = transparent (nothing drawn).

export type IconName = 'wing' | 'calendar' | 'mail' | 'doc' | 'check' | 'clock' | 'game' | 'contact' | 'sheet'

type Ctx = CanvasRenderingContext2D

function stroke(ctx: Ctx, width = 2) {
  ctx.strokeStyle = '#fff'
  ctx.fillStyle = '#fff'
  ctx.lineWidth = width
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
}

/**
 * The Wingman mark: a bird seen head-on, two swept wings meeting at the body,
 * with three feather notches on each wing. Fits any square `s`.
 */
export function drawLogo(ctx: Ctx, x: number, y: number, s: number) {
  const u = s / 28
  const X = (v: number) => x + v * u
  const Y = (v: number) => y + v * u
  ctx.fillStyle = '#fff'
  // Wings: a filled crescent from tip to tip, thick at the body, thin at the tips.
  ctx.beginPath()
  ctx.moveTo(X(1), Y(5))
  ctx.quadraticCurveTo(X(8), Y(22), X(14), Y(23))
  ctx.quadraticCurveTo(X(20), Y(22), X(27), Y(5))
  ctx.quadraticCurveTo(X(20), Y(13), X(14), Y(14))
  ctx.quadraticCurveTo(X(8), Y(13), X(1), Y(5))
  ctx.closePath()
  ctx.fill()
  // Feather notches, cut out of the trailing edge.
  ctx.fillStyle = '#000'
  for (const [fx, fy] of [
    [5, 11],
    [9, 16],
    [19, 16],
    [23, 11],
  ]) {
    ctx.beginPath()
    ctx.moveTo(X(fx), Y(fy + 5))
    ctx.lineTo(X(fx + 1.2), Y(fy))
    ctx.lineTo(X(fx + 2.4), Y(fy + 5))
    ctx.closePath()
    ctx.fill()
  }
  // Head.
  ctx.fillStyle = '#fff'
  ctx.beginPath()
  ctx.arc(X(14), Y(8.5), 2.6 * u, 0, Math.PI * 2)
  ctx.fill()
}

const pngCache = new Map<string, Promise<Uint8Array>>()

/** `toPng`, memoised by `key`: icons and the logo are encoded once per session. */
export function cachedPng(key: string, width: number, height: number, draw: (ctx: Ctx) => void): Promise<Uint8Array> {
  let p = pngCache.get(key)
  if (!p) {
    p = toPng(width, height, draw)
    pngCache.set(key, p)
  }
  return p
}

/** 20x20 icons at (x, y). */
export function drawIcon(ctx: Ctx, name: IconName, x: number, y: number) {
  stroke(ctx)
  ctx.beginPath()
  switch (name) {
    case 'wing':
      drawLogo(ctx, x, y, 20)
      return
    case 'calendar':
      ctx.rect(x + 2, y + 4, 16, 14)
      ctx.moveTo(x + 2, y + 8)
      ctx.lineTo(x + 18, y + 8)
      ctx.moveTo(x + 6, y + 2)
      ctx.lineTo(x + 6, y + 6)
      ctx.moveTo(x + 14, y + 2)
      ctx.lineTo(x + 14, y + 6)
      ctx.stroke()
      ctx.fillRect(x + 5, y + 11, 3, 3)
      ctx.fillRect(x + 10, y + 11, 3, 3)
      return
    case 'mail':
      ctx.rect(x + 2, y + 4, 16, 12)
      ctx.moveTo(x + 2, y + 5)
      ctx.lineTo(x + 10, y + 11)
      ctx.lineTo(x + 18, y + 5)
      ctx.stroke()
      return
    case 'doc':
      ctx.moveTo(x + 4, y + 2)
      ctx.lineTo(x + 12, y + 2)
      ctx.lineTo(x + 16, y + 6)
      ctx.lineTo(x + 16, y + 18)
      ctx.lineTo(x + 4, y + 18)
      ctx.closePath()
      ctx.moveTo(x + 7, y + 9)
      ctx.lineTo(x + 13, y + 9)
      ctx.moveTo(x + 7, y + 13)
      ctx.lineTo(x + 13, y + 13)
      ctx.stroke()
      return
    case 'sheet':
      ctx.rect(x + 2, y + 3, 16, 14)
      ctx.moveTo(x + 2, y + 8)
      ctx.lineTo(x + 18, y + 8)
      ctx.moveTo(x + 2, y + 12)
      ctx.lineTo(x + 18, y + 12)
      ctx.moveTo(x + 8, y + 3)
      ctx.lineTo(x + 8, y + 17)
      ctx.stroke()
      return
    case 'check':
      ctx.arc(x + 10, y + 10, 8, 0, Math.PI * 2)
      ctx.moveTo(x + 6, y + 10)
      ctx.lineTo(x + 9, y + 13)
      ctx.lineTo(x + 14, y + 7)
      ctx.stroke()
      return
    case 'clock':
      ctx.arc(x + 10, y + 10, 8, 0, Math.PI * 2)
      ctx.moveTo(x + 10, y + 5)
      ctx.lineTo(x + 10, y + 10)
      ctx.lineTo(x + 14, y + 12)
      ctx.stroke()
      return
    case 'contact':
      ctx.arc(x + 10, y + 7, 4, 0, Math.PI * 2)
      ctx.moveTo(x + 3, y + 18)
      ctx.quadraticCurveTo(x + 10, y + 9, x + 17, y + 18)
      ctx.stroke()
      return
    case 'game': {
      // A tiny dino silhouette.
      ctx.fillRect(x + 10, y + 3, 8, 6)
      ctx.fillRect(x + 6, y + 8, 10, 6)
      ctx.fillRect(x + 2, y + 9, 5, 3)
      ctx.fillRect(x + 7, y + 14, 3, 4)
      ctx.fillRect(x + 12, y + 14, 3, 4)
      ctx.fillStyle = '#000'
      ctx.fillRect(x + 12, y + 4, 2, 2)
      return
    }
  }
}

const canvases = new Map<string, HTMLCanvasElement>()

/** Draws with a 2D context onto a (reused) offscreen canvas and returns PNG bytes. */
export async function toPng(width: number, height: number, draw: (ctx: Ctx) => void): Promise<Uint8Array> {
  const key = `${width}x${height}`
  let canvas = canvases.get(key)
  if (!canvas) {
    canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    canvases.set(key, canvas)
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2d canvas context unavailable')
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, width, height)
  draw(ctx)
  const blob: Blob = await new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'),
  )
  return new Uint8Array(await blob.arrayBuffer())
}
