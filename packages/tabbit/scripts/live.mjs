// Drives one real turn against a live Tabbit build and prints the reply.
// Usage: TABBIT_TOKEN=<cookie value> TABBIT_SITE=tabbit bun scripts/live.mjs "hi"
import { SITES } from "../src/sites.mjs"
import { TabbitSession, envelopes } from "../src/protocol.mjs"

const site = SITES[process.env.TABBIT_SITE ?? "tabbit-ai"]
const token = process.env.TABBIT_TOKEN
const prompt = process.argv[2] ?? "Reply with OK only"
const model = process.env.TABBIT_MODEL ?? "DeepSeek-V4.1-Flash"

if (!token) {
  console.error("TABBIT_TOKEN is required")
  process.exit(1)
}

const cookie = `token=${token}`
const fetchImpl = (url, options = {}) => fetch(url, { ...options, headers: { ...options.headers, cookie } })
const session = new TabbitSession(site, { fetchImpl })

const roomId = await session.createRoom()
console.log("room:", roomId)
const runId = await session.createRun(roomId, { content: prompt, model })
console.log("run:", runId)

const stream = await session.join(roomId)
let text = ""
for await (const { event, data } of envelopes(stream)) {
  if (event === "assistant_message_delta") {
    text += data.payload?.delta ?? ""
    process.stdout.write(data.payload?.delta ?? "")
  } else if (event === "run_completed") {
    console.log("\nstatus: COMPLETED")
  } else if (event === "run_failed") {
    console.log("\nstatus: FAILED", JSON.stringify(data.payload))
  }
}
console.log("reply:", JSON.stringify(text))
