# Wingman

A meeting and inbox copilot for Even Realities G2 smart glasses.

- **Next meeting** at a glance, with an AI briefing: what it's for, your last email thread with the attendees, and open questions.
- **Inbox triage**: unread mail summarized to one line, with important messages starred and suggested replies ready to go.
- **Replies and new emails by voice**: "Thursday works, see you at 12:30" on an email, or "Email Priya that I'm running ten minutes late" from home. Gemini writes the draft.
- **Meeting follow-ups** by voice, sent to everyone who attended.
- **Calendar invites** by voice: "Lunch with Sam Thursday at 1".
- **Ask Wingman**, a conversation: "what's unread", "open the second one", "reply saying yes", "find the offsite budget sheet", "add a row: Vineyard, 12000", "what's in the launch plan doc", "when am I free tomorrow", "who is Priya". It remembers the conversation, so "that one" and "the second one" work. Gemini chooses from 22 tools over Gmail, Calendar, Contacts, Drive, Docs and Sheets; Google's Workspace MCP servers can be attached on top (`WORKSPACE_MCP=1`).

Nothing is sent without your confirmation. Every draft and invite opens for review and only goes out when you pick **Send** (or **Save to Gmail drafts**). Each draft can be sent at most once.

## How it fits together

```
G2 glasses + R1 ring ⇄ BLE ⇄ Even app WebView [plugin/]
                                  │  WebSocket: JSON requests + mic audio
                                  ▼
                   bridge/ on your PC (Node)
                    ├─ Gmail + Google Calendar (your OAuth token stays on the PC)
                    ├─ Gemini: triage, briefings, drafts, intent
                    └─ Deepgram: live speech-to-text
```

- **`plugin/`** is the Even Hub app (Vite + TypeScript + `@evenrealities/even_hub_sdk`). It only renders text and handles input; navigation is a pure reducer (`src/app/reducer.ts`).
- **`bridge/`** holds every credential, caches calendar and inbox, runs the AI and speech-to-text, and owns draft state (`src/wingman.ts`).
- **`shared/protocol.ts`** is the message contract both packages compile against.

## Controls

| Gesture (temple or ring) | What it does |
|---|---|
| Swipe | Move the cursor, or turn the page |
| Tap | Open the item, or open actions (reply, send, ...) |
| Hold | Talk: on home, the inbox or the chat, ask Wingman anything; on an email, a reply; on a meeting, a follow-up; on a draft, changes to it. Release to finish. |
| Double-tap | Back (exits from home) |

The phone screen mirrors the glasses and has the same buttons, including **Hold to talk**.

## Setup

Requirements: Node 20+, the Even Realities app paired with your G2, and the [`everything-evenhub`](https://hub.evenrealities.com/docs/learn/claude-code) Claude Code plugin (recommended).

### 1. Install and pair the plugin with the bridge

```bash
cd bridge && npm install
cd ../plugin && npm install
```

Generate a token and put it in both `bridge/.env` (`WINGMAN_TOKEN`, copied from `bridge/.env.example`) and `plugin/.env.local` (`VITE_BRIDGE_TOKEN`, copied from `plugin/.env.example`):

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

Set `FAKE_GOOGLE=1` in `bridge/.env` to try everything on demo data first. No accounts are needed, and sends are only logged.

### 2. Google (Gmail + Calendar)

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project and enable the **Gmail**, **Google Calendar**, **People**, **Google Drive**, **Google Docs** and **Google Sheets** APIs.
2. Under **OAuth consent screen**, choose External, leave it in **Testing**, and add your Google address as a test user.
3. Under **Credentials**, create an **OAuth client ID** of type **Desktop app**. Download the JSON and save it as `bridge/.data/google-client.json`.
4. Set `FAKE_GOOGLE=0` in `bridge/.env`, then sign in. This opens your browser:
   ```bash
   cd bridge && npm run auth
   ```

The token is stored in `bridge/.data/` (gitignored) and never leaves your PC. While the app is in Testing, Google expires the sign-in after 7 days. The glasses then show **Google sign-in needed**: tap to open the sign-in page on your PC, or run `npm run auth` again.

### 3. Gemini and Deepgram

In `bridge/.env`:
- `GEMINI_API_KEY` from [Google AI Studio](https://aistudio.google.com/apikey). Without it, a canned fake writes the drafts.
- `DEEPGRAM_API_KEY` from the [Deepgram console](https://console.deepgram.com). Without it, speech-to-text is a scripted fake.

## Run

Use three terminals:

```bash
cd bridge && npm run dev        # bridge on :8787; the log shows which services are real or fake
cd plugin && npm run dev        # Vite on :5173 (proxies /bridge to the bridge)
cd plugin && npm run simulate   # desktop glasses simulator (automation API on :9898)
```

`node plugin/scripts/sim.mjs down click shot out.png` drives the simulator from a script. The simulator has no long-press, so use the on-screen **● Speak** items or the phone's **Hold to talk** button.

### On your glasses

Live reload with QR code (needs Developer Mode, which you get by signing in at hub.evenrealities.com):

```bash
cd plugin && npx evenhub qr --url http://<your-pc-lan-ip>:5173
```

Scan it from the Even app's **Even Hub** tab. Don't use the Terminal feature's scanner.

Or install a packaged build. Set `VITE_BRIDGE_URL=ws://<your-pc-lan-ip>:8787/ws` in `plugin/.env.production.local`, put the same address in the `network` whitelist in `plugin/app.json`, then:

```bash
cd plugin && npm run pack       # → plugin/wingman.ehpk
```

At hub.evenrealities.com, open **Projects → Wingman**, upload the build and make it a **Beta**. Invite yourself under **Testing Group**, then scan the QR code in the invite email with your phone's **camera app**. Wingman appears under **Plugins → Beta**.

## Test

```bash
cd bridge && npm test           # unit tests: MIME, contacts, AI output validation, send-once drafts, the agent loop
cd plugin && npm test           # reducer flows, chat screens and text layout
cd bridge && npm run smoke      # every voice flow end to end over the WebSocket (needs FAKE_GOOGLE=1)
cd bridge && npm run chat -- "what is unread"      # talk to the agent from the terminal (fake data unless ALLOW_REAL=1)
```

## How the agent stays safe

Every tool that changes something (send, create event, edit a doc, append rows, MCP mutations) only *prepares* the action: the glasses show a preview and nothing runs until you tap **Approve**. Each prepared action runs at most once. The model can only use ids that came back from its own tool results, so it can't invent an email or file to act on. Email and document contents are passed to the model as data, with instructions to ignore anything inside them that looks like a command.

## Privacy

Email and calendar content is sent to Gemini to summarize and draft, and your voice is sent to Deepgram. Neither key ever reaches the glasses or phone. The bridge never logs email bodies or transcripts. Keep it on your home network (or Tailscale); it only accepts clients that present `WINGMAN_TOKEN`.
