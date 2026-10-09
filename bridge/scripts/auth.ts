// One-time Google sign-in: `npm run auth`. Opens the browser on this PC and
// stores a refresh token in .data/google-token.json (gitignored).
import { runAuthFlow } from '../src/google/auth.ts'

try {
  const email = await runAuthFlow()
  console.log(`Signed in as ${email}. The running bridge picks this up automatically.`)
  process.exit(0)
} catch (err) {
  console.error((err as Error).message)
  process.exit(1)
}
