# Wingman

Claude Code on Even Realities G2 smart glasses. Talk to Claude through the glasses mic, read answers on the display, and approve every action with the temple touchpad or R1 ring. Gmail and Google Calendar come in as MCP tools Claude can use.

Nothing runs or is sent without your confirmation on the glasses.

## How it fits together

```
G2 glasses ⇄ BLE ⇄ Even app WebView [plugin/]
                          │  WebSocket (token auth)
                          ▼
             bridge/ on your PC (Node + Claude Agent SDK)
              ├─ speech-to-text for mic audio
              ├─ Claude Code sessions in your project folders
              └─ MCP servers (Gmail, Calendar, …)
```

- **`plugin/`**: the Even Hub app (Vite + TypeScript + `@evenrealities/even_hub_sdk`), started from the official `asr` template. It runs in the Even Realities phone app and draws on the glasses.
- **`bridge/`**: a WebSocket server on your PC. In dev, the plugin reaches it through the Vite proxy at `/bridge`. For use away from home, it will sit behind a tunnel.

## Setup

Requirements: Node 20+ and the Even Realities app paired with your G2. The [`everything-evenhub`](https://hub.evenrealities.com/docs/learn/claude-code) Claude Code plugin is recommended.

1. Create the env files. Generate a token, then put it in **both** files:
   ```bash
   node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
   ```
   - `bridge/.env` (copy `bridge/.env.example`): `WINGMAN_TOKEN=<token>`, plus `ANTHROPIC_API_KEY` once Claude is wired in.
   - `plugin/.env.local` (copy `plugin/.env.example`): `VITE_BRIDGE_TOKEN=<token>`.
2. Install dependencies:
   ```bash
   cd bridge && npm install
   cd ../plugin && npm install
   ```

## Run

Use three terminals:

```bash
cd bridge && npm run dev        # bridge on :8787
cd plugin && npm run dev        # Vite on :5173 (proxies /bridge → bridge)
cd plugin && npm run simulate   # desktop glasses simulator (automation API on :9898)
```

On real glasses, with your phone on the same Wi-Fi as the PC:

```bash
cd plugin && npx evenhub qr --url http://<your-pc-lan-ip>:5173
```

Scan the code with the Even Realities app. The glasses should show **"Bridge connected"**. Double-tap to exit.

## Roadmap

1. ~~Project setup: plugin ⇄ bridge connection with token auth~~
2. Push-to-talk: long-press to record, then speech-to-text on the bridge (local Whisper)
3. Claude Agent SDK on the bridge, with answers streamed to the glasses in a glasses-sized format
4. Approve or deny tool use on the glasses (`canUseTool`)
5. Session list and resume
6. Gmail and Google Calendar MCP servers
7. Tunnel and a pairing flow (replaces the dev-only token in `.env.local`), then package as `.ehpk`
