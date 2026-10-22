import { describe, expect, test } from "bun:test"
import { lastUserText } from "../src/openai.mjs"
import { parseBlockForTest } from "../src/protocol.mjs"

describe("lastUserText", () => {
  test("reads a plain string content", () => {
    expect(lastUserText({ messages: [{ role: "user", content: "hi" }] })).toBe("hi")
  })

  test("reads the last user turn, not the first", () => {
    expect(lastUserText({ messages: [{ role: "user", content: "first" }, { role: "user", content: "second" }] })).toBe("second")
  })

  test("flattens OpenAI content parts and skips images", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this" },
            { type: "image_url", image_url: { url: "https://example.com/a.png" } },
          ],
        },
      ],
    }
    expect(lastUserText(body)).toBe("what is this")
  })

  test("returns null when there is no user text", () => {
    expect(lastUserText({ messages: [{ role: "assistant", content: "hi" }] })).toBeNull()
    expect(lastUserText({})).toBeNull()
    expect(lastUserText({ messages: [{ role: "user", content: "  " }] })).toBeNull()
  })
})

describe("parseBlockForTest", () => {
  test("parses a Tabbit SSE envelope", () => {
    const block = 'event: assistant_message_delta\ndata: {"payload":{"delta":"OK"}}'
    expect(parseBlockForTest(block)).toEqual({ event: "assistant_message_delta", data: { payload: { delta: "OK" } } })
  })

  test("ignores comments and data-less blocks", () => {
    expect(parseBlockForTest(": keep-alive")).toBeNull()
    expect(parseBlockForTest("event: ping")).toBeNull()
  })

  test("survives CRLF line endings", () => {
    const block = 'event: run_completed\r\ndata: {"payload":{"status":"COMPLETED"}}'
    expect(parseBlockForTest(block)?.event).toBe("run_completed")
  })
})
