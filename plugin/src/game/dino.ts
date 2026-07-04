// Dino run for the glasses: tap to jump, swipe down to duck. Pure engine +
// a canvas renderer; the display sends each frame as a 288x88 PNG.
// Sprites are pixel art drawn 1 px per cell, so frames stay tiny over BLE.

export const W = 288
export const H = 88
export const GROUND_Y = H - 10
const DINO_X = 24
const GRAVITY = 900 // px/s²: a floaty jump spans 4-5 frames at ~7 fps
const JUMP_V = -320 // apex ~57 px, just under the top of the play area
// A tap shows up a frame later over Bluetooth, so the jump starts visibly
// off the ground in the very first frame after the tap.
const JUMP_LIFT = 6
const DUCK_MS = 650
// Input over Bluetooth arrives 100-200 ms late and frames are ~100 ms apart,
// so a tap shortly before landing still jumps (buffer), and a tap shortly
// after leaving the ground still counts (coyote).
const JUMP_BUFFER_MS = 220
const COYOTE_MS = 90

// ── Sprites (facing right; '#' = lit) ───────────────────────────────────

const REX = [
  '....................',
  '....................',
  '...........#########',
  '..........##.#######',
  '..........##########',
  '..........##########',
  '..........######....',
  '#.........########..',
  '##......#########...',
  '###....###########..',
  '####..###########...',
  '#################...',
  '.###############....',
  '..#############.....',
  '...###########......',
  '....#########.......',
  '.....#######........',
]
const LEGS_A = ['......##..##........', '......##..###.......', '......###...........']
const LEGS_B = ['......##..##........', '......###..##.......', '...........###......']
const REX_DEAD_EYE = ['..........##.#######', '..........#.########'] // row 3 variants: open, "x"

const REX_DUCK = [
  '.....................#########',
  '....................##.#######',
  '#...................##########',
  '##..........##########.######.',
  '###..##########################',
  '##############################',
  '.############################.',
  '...#######################....',
  '.....#####..####..............',
  '.....##.....##................',
  '.....###....###...............',
]

const CACTUS_S = ['...##..', '...##..', '#..##..', '#..##.#', '#..##.#', '##.##.#', '.####.#', '.####.#', '...###.', '...##..', '...##..', '...##..', '...##..', '...##..']
const CACTUS_L = [
  '....##.......',
  '....##..##...',
  '#...##..##...',
  '#...##..##.#.',
  '#...##..##.#.',
  '##..##..##.#.',
  '.####...##.#.',
  '.####...####.',
  '....##..##...',
  '....##..##...',
  '....##..##...',
  '....##..##...',
  '....##..##...',
  '....##..##...',
  '....##..##...',
  '....##..##...',
]
const BIRD_UP = ['.....#...........', '....###..........', '...#####.........', '..######.........', '####################', '......########......', '.........####.......']
const BIRD_DOWN = ['....................', '####################', '......########......', '...#####............', '....###.............', '.....#..............', '....................']

export const DINO_W = REX[0].length
export const DINO_H = REX.length + LEGS_A.length // 20
const DUCK_W = REX_DUCK[0].length
const DUCK_H = REX_DUCK.length

function blit(ctx: CanvasRenderingContext2D, rows: string[], x: number, y: number) {
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]
    let start = -1
    for (let c = 0; c <= row.length; c++) {
      const on = c < row.length && row[c] === '#'
      if (on && start < 0) start = c
      if (!on && start >= 0) {
        ctx.fillRect(x + start, y + r, c - start, 1)
        start = -1
      }
    }
  }
}

// ── Engine ───────────────────────────────────────────────────────────────

export interface Obstacle {
  x: number
  w: number
  h: number
  /** Flying obstacles must be ducked under. */
  flying: boolean
}

// ── Levels ───────────────────────────────────────────────────────────────
// Hand-made segments instead of random spawning: every gap is known to be
// jumpable at the game's speed, and runs have a rhythm.
// `at` is the obstacle offset in px from the segment start; `length` includes the run-out.
// At 85-135 px/s a jump covers 50-80 px, so separate jumps are >= 110 px apart
// and a cactus never follows a bird by less than 140 px.

type Kind = 'small' | 'large' | 'bird'
interface Segment {
  length: number
  tier: 1 | 2 | 3
  obstacles: { at: number; kind: Kind }[]
}

const SEGMENTS: Segment[] = [
  // Tier 1: single obstacles and gentle pairs.
  { tier: 1, length: 260, obstacles: [{ at: 0, kind: 'small' }] },
  { tier: 1, length: 300, obstacles: [{ at: 0, kind: 'large' }] },
  { tier: 1, length: 430, obstacles: [{ at: 0, kind: 'small' }, { at: 210, kind: 'small' }] },
  { tier: 1, length: 470, obstacles: [{ at: 0, kind: 'large' }, { at: 240, kind: 'small' }] },
  { tier: 1, length: 180, obstacles: [] }, // a breather
  // Tier 2: closer pairs and the first birds.
  { tier: 2, length: 540, obstacles: [{ at: 0, kind: 'small' }, { at: 150, kind: 'small' }, { at: 340, kind: 'large' }] },
  { tier: 2, length: 420, obstacles: [{ at: 0, kind: 'bird' }, { at: 200, kind: 'small' }] },
  { tier: 2, length: 500, obstacles: [{ at: 0, kind: 'large' }, { at: 140, kind: 'small' }, { at: 340, kind: 'bird' }] },
  { tier: 2, length: 380, obstacles: [{ at: 0, kind: 'small' }, { at: 120, kind: 'small' }] },
  { tier: 2, length: 360, obstacles: [{ at: 0, kind: 'bird' }, { at: 160, kind: 'bird' }] },
  // Tier 3: triples, mixed heights, quick duck-then-jump.
  { tier: 3, length: 580, obstacles: [{ at: 0, kind: 'bird' }, { at: 150, kind: 'bird' }, { at: 340, kind: 'large' }] },
  { tier: 3, length: 560, obstacles: [{ at: 0, kind: 'small' }, { at: 115, kind: 'large' }, { at: 310, kind: 'small' }, { at: 430, kind: 'bird' }] },
  { tier: 3, length: 470, obstacles: [{ at: 0, kind: 'large' }, { at: 160, kind: 'large' }, { at: 320, kind: 'large' }] },
  { tier: 3, length: 440, obstacles: [{ at: 0, kind: 'bird' }, { at: 140, kind: 'small' }, { at: 260, kind: 'small' }] },
]

/** Which tiers are in play at this point of the run. */
function tiersFor(t: number): number[] {
  if (t < 10_000) return [1]
  if (t < 25_000) return [1, 2]
  return [1, 2, 3]
}

export function pickSegment(t: number, lastIndex: number, rand: () => number): number {
  const tiers = tiersFor(t)
  const pool = SEGMENTS.map((_, i) => i).filter(i => tiers.includes(SEGMENTS[i].tier) && i !== lastIndex)
  return pool[Math.floor(rand() * pool.length) % pool.length]
}

export interface Dino {
  y: number // dino top-left y (standing)
  vy: number
  duckUntil: number
  obstacles: Obstacle[]
  /** World distance (px scrolled) at which the next segment starts. */
  nextAt: number
  dist: number
  lastSegment: number
  speed: number
  score: number
  best: number
  over: boolean
  t: number
  started: boolean
  /** A jump requested in the air, honoured if the dino lands before this time. */
  jumpUntil: number
  lastGroundT: number
}

export function newGame(best = 0): Dino {
  return {
    y: GROUND_Y - DINO_H,
    vy: 0,
    duckUntil: 0,
    obstacles: [],
    nextAt: 120,
    dist: 0,
    lastSegment: -1,
    speed: 85,
    score: 0,
    best,
    over: false,
    t: 0,
    started: false,
    jumpUntil: 0,
    lastGroundT: 0,
  }
}

export const isDucking = (g: Dino) => g.t < g.duckUntil && g.y >= GROUND_Y - DINO_H - 1
const onGround = (g: Dino) => g.y >= GROUND_Y - DINO_H - 0.5

export function jump(g: Dino): Dino {
  if (g.over) return { ...newGame(g.best), started: true }
  if (!g.started) return { ...g, started: true }
  if (onGround(g) || g.t - g.lastGroundT <= COYOTE_MS) return { ...g, y: g.y - JUMP_LIFT, vy: JUMP_V, duckUntil: 0, jumpUntil: 0 }
  return { ...g, jumpUntil: g.t + JUMP_BUFFER_MS }
}

export function duck(g: Dino): Dino {
  if (g.over || !g.started) return g
  return { ...g, duckUntil: g.t + DUCK_MS }
}

const BIRD_H = BIRD_UP.length
const BIRD_W = BIRD_UP[4].length
/** Birds fly at the standing dino's head height: duck or die. */
const BIRD_Y = GROUND_Y - DINO_H - 3

/** Advances the game by `dt` ms. Deterministic given `rand`. */
export function tick(g0: Dino, dt: number, rand: () => number = Math.random): Dino {
  if (!g0.started || g0.over) return g0
  const g = { ...g0, t: g0.t + dt, obstacles: g0.obstacles.map(o => ({ ...o })) }
  const s = dt / 1000
  // Dino physics.
  g.vy += GRAVITY * s
  g.y += g.vy * s
  if (g.y > GROUND_Y - DINO_H) {
    g.y = GROUND_Y - DINO_H
    g.vy = 0
  }
  if (onGround(g)) {
    g.lastGroundT = g.t
    if (g.jumpUntil > g.t) {
      g.y -= JUMP_LIFT
      g.vy = JUMP_V
      g.jumpUntil = 0
    }
  }
  // World. Slow enough that a ~150 ms frame moves at most ~20 px even late in
  // a run, so a jump is several visible frames rather than a skip.
  g.speed = 85 + Math.min(50, g.t / 250)
  const moved = g.speed * s
  g.dist += moved
  for (const o of g.obstacles) o.x -= moved
  g.obstacles = g.obstacles.filter(o => o.x + o.w > 0)
  // Lay down the next segment as soon as the world reaches it.
  while (g.dist >= g.nextAt) {
    const i = pickSegment(g.t, g.lastSegment, rand)
    const seg = SEGMENTS[i]
    const start = W + 10 - (g.dist - g.nextAt)
    for (const o of seg.obstacles) {
      g.obstacles.push(
        o.kind === 'bird'
          ? { x: start + o.at, w: BIRD_W, h: BIRD_H, flying: true }
          : { x: start + o.at, w: o.kind === 'large' ? CACTUS_L[0].length : CACTUS_S[0].length, h: o.kind === 'large' ? CACTUS_L.length : CACTUS_S.length, flying: false },
      )
    }
    g.lastSegment = i
    g.nextAt += seg.length
  }
  g.score = Math.floor(g.t / 100)
  // Collision. The hitbox is forgiving: at 10 fps and Bluetooth latency,
  // near misses should feel like misses.
  const ducking = isDucking(g)
  const dBox = ducking
    ? { x: DINO_X + 4, y: GROUND_Y - DUCK_H + 2, w: DUCK_W - 8, h: DUCK_H - 3 }
    : { x: DINO_X + 4, y: g.y + 3, w: DINO_W - 9, h: DINO_H - 4 }
  for (const o of g.obstacles) {
    const oy = o.flying ? BIRD_Y : GROUND_Y - o.h
    const ox = o.x + 2
    const ow = o.w - 4
    const hit = dBox.x < ox + ow && dBox.x + dBox.w > ox && dBox.y < oy + o.h && dBox.y + dBox.h > oy
    if (hit) {
      g.over = true
      g.best = Math.max(g.best, g.score)
      break
    }
  }
  return g
}

// ── Rendering ────────────────────────────────────────────────────────────

export function draw(ctx: CanvasRenderingContext2D, g: Dino) {
  ctx.fillStyle = '#fff'
  // Ground with a scrolling dash pattern.
  ctx.fillRect(0, GROUND_Y, W, 1)
  const phase = Math.floor(g.t * 0.12) % 20
  for (let x = -phase; x < W; x += 20) ctx.fillRect(x, GROUND_Y + 4, 5, 1)

  // Dino.
  if (isDucking(g)) {
    blit(ctx, REX_DUCK, DINO_X, GROUND_Y - DUCK_H)
  } else {
    const legs = !onGround(g) || g.over ? LEGS_A : Math.floor(g.t / 110) % 2 === 0 ? LEGS_A : LEGS_B
    const body = g.over ? [...REX.slice(0, 3), REX_DEAD_EYE[1], ...REX.slice(4)] : REX
    blit(ctx, [...body, ...legs], DINO_X, Math.round(g.y))
  }

  // Obstacles.
  for (const o of g.obstacles) {
    const x = Math.round(o.x)
    if (o.flying) blit(ctx, Math.floor(g.t / 160) % 2 === 0 ? BIRD_UP : BIRD_DOWN, x, BIRD_Y)
    else blit(ctx, o.h === CACTUS_L.length ? CACTUS_L : CACTUS_S, x, GROUND_Y - o.h)
  }

  if (!g.started) {
    ctx.font = 'bold 13px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('tap to start', W / 2, 26)
  } else if (g.over) {
    ctx.font = 'bold 14px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('G A M E  O V E R', W / 2, 22)
    ctx.font = '11px sans-serif'
    ctx.fillText('tap to play again', W / 2, 38)
  }
}
