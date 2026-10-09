import type {
  Briefing,
  ChatTurn,
  PendingRef,
  Draft,
  DraftAction,
  EmailDetail,
  ErrorCode,
  HomeData,
  InboxItem,
  InviteAction,
  InviteDraft,
  Meeting,
  Person,
  Request,
  ResponseMap,
  ServerPush,
  VoiceContext,
} from '../../../shared/protocol'
import type { Gesture } from '../glasses/input'
import type { Dino } from '../game/dino'

export type Conn = 'connecting' | 'ready' | 'offline' | 'unauthorized'

export type MenuAction =
  | { kind: 'voice'; ctx: VoiceContext; label: string }
  | { kind: 'suggestion'; emailId: string; index: number }
  | { kind: 'draftAct'; draftId: string; action: DraftAction; label: string }
  | { kind: 'inviteAct'; inviteId: string; action: InviteAction; label: string }
  | { kind: 'actionAct'; id: string; approve: boolean; label: string }
  | { kind: 'back' }

export interface MenuItem {
  label: string
  action: MenuAction
}

export type Screen =
  | { name: 'home'; cursor: number }
  | { name: 'inbox'; cursor: number }
  | { name: 'email'; id: string; email: EmailDetail | null; page: number }
  | { name: 'meeting'; id: string; data: { meeting: Meeting; briefing: Briefing } | null; page: number }
  | { name: 'menu'; title: string; items: MenuItem[]; cursor: number; openedAt: number }
  | { name: 'dictate'; ctx: VoiceContext; label: string; final: string; interim: string; mode: 'hold' | 'toggle'; micWarning: boolean }
  | { name: 'thinking'; label: string; token: number; heard?: string }
  | { name: 'contacts'; pendingId: string; query: string; candidates: Person[]; cursor: number }
  | { name: 'draft'; draft: Draft; page: number }
  | { name: 'invite'; invite: InviteDraft; page: number }
  // until === null keeps the result on screen until the user taps; retry lets a tap speak again.
  | { name: 'result'; message: string; ok: boolean; until: number | null; retry?: VoiceContext }
  | { name: 'recent'; cursor: number }
  // Chat agent: the conversation (paged, newest last), a reply's card, and approvals.
  | { name: 'chat'; page: number }
  | { name: 'card'; turnId: string; cursor: number }
  | { name: 'textCard'; turnId: string; page: number }
  | { name: 'approval'; pending: PendingRef; lines: string[]; page: number }
  | { name: 'game'; dino: Dino }
  | { name: 'auth'; waiting: boolean }

export interface State {
  conn: Conn
  connDetail: string
  fake: boolean
  stack: Screen[] // last element is on screen
  home: HomeData | null
  homeError: string
  inbox: InboxItem[] | null
  chat: ChatTurn[] | null
  /** Mic peak while dictating, 0..1, for the listening meter. */
  micLevel: number
  dinoBest: number
  /** Measured game frame rate, for the header. */
  gameFps: number
  now: number
  lastHoldEnd: number
  nudgedMeetingId: string
  nextToken: number
  /** Context of the last voice session, so an unknown result can offer "try again". */
  lastVoiceCtx: VoiceContext | null
}

export type Action =
  | { type: 'conn'; conn: Conn; detail?: string; authNeeded?: boolean; fake?: boolean }
  | { type: 'gesture'; gesture: Gesture; now: number }
  | { type: 'response'; req: Request; res: ResponseMap[Request['type']]; token?: number }
  | { type: 'failed'; req: Request; code: ErrorCode | 'OFFLINE' | 'TIMEOUT'; message: string; token?: number }
  | { type: 'push'; msg: ServerPush }
  | { type: 'tick'; now: number }
  | { type: 'micSilent' }
  | { type: 'micLevel'; level: number }
  | { type: 'gameTick'; dt: number }
  | { type: 'dinoBest'; best: number }
  | { type: 'gameFps'; fps: number }

export type Effect =
  | { kind: 'request'; req: Request; token?: number }
  | { kind: 'mic'; on: boolean }
  | { kind: 'exit' }
  | { kind: 'saveBest'; best: number }

export function initialState(now = Date.now()): State {
  return {
    conn: 'connecting',
    connDetail: '',
    fake: false,
    stack: [{ name: 'home', cursor: 0 }],
    home: null,
    homeError: '',
    inbox: null,
    chat: null,
    micLevel: 0,
    dinoBest: 0,
    gameFps: 0,
    now,
    lastHoldEnd: 0,
    nudgedMeetingId: '',
    nextToken: 1,
    lastVoiceCtx: null,
  }
}

export const top = (s: State): Screen => s.stack[s.stack.length - 1]
