# Wingman glasses app

The Even Hub plugin half of Wingman. See the [project README](../README.md) for setup.

| Path | Role |
|---|---|
| `src/main.ts` | Wiring: SDK events → gestures → reducer → effects and display |
| `src/app/reducer.ts` | All navigation and interaction logic, pure `(state, action) → {state, effects}` |
| `src/render/screens.ts` | Pure rendering of each screen into header / body / footer text |
| `src/render/text.ts` | Pixel-accurate wrapping with `@evenrealities/pretext` (8 body lines, never overflows) |
| `src/glasses/display.ts` | The glasses page and a single latest-wins write queue |
| `src/glasses/input.ts` | SDK event → gesture mapping (tap arrives as `eventType` undefined) |
| `src/glasses/mic.ts` | Glasses mic → bridge, with a silent-mic watchdog |
| `src/bridge/client.ts` | WebSocket client: typed requests, pushes, binary audio, reconnect |
| `src/ui.ts` | Phone companion page: mirror of the glasses plus on-screen controls |

G2 notes learned the hard way:
- With a hidden 1×1 event-capture container, the simulator passed on only the first of several swipes in a row. Capturing on the body, whose text is pre-wrapped so it never overflows, delivers every swipe.
- A 28px container with no padding fits one 27px line. With padding, the firmware adds a scrollbar.
- `createStartUpPageContainer` works once per launch; after a reload the display falls back to `rebuildPageContainer`.
- The simulator has no long-press. Every voice action also has a tap path.
