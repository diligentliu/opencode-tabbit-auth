// magpie hands a plugin one API shape per model: chat completions for
// @ai-sdk/openai-compatible. Tabbit has no OpenAI-compatible surface, so this
// module is the bridge: chat completions in, Tabbit runs out, chat completion
// chunks back.

import { TabbitSession, envelopes } from "./protocol.mjs"

const encoder = new TextEncoder()

export const openaiChunk = (payload) => encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
export const openaiDone = () => encoder.encode("data: [DONE]\n\n")

const finish = (model, reason = "stop") =>
  openaiChunk({
    id: "chatcmpl-tabbit",
    object: "chat.completion.chunk",
    model,
    choices: [{ index: 0, delta: {}, finish_reason: reason }],
  })

/**
 * Turns one chat-completions request into a Tabbit turn and streams the reply.
 * Tabbit's API does not accept caller-defined tools. Refuse those requests
 * instead of silently dropping the tool contract.
 */
export async function streamChatCompletion(site, body, { fetchImpl = fetch, signal } = {}) {
  assertTextOnly(body)
  const prompt = conversationText(body)
  if (!prompt) throw new Error("Tabbit needs a user message")
  const model = body.model ?? "DeepSeek-V4.1-Flash"

  const session = new TabbitSession(site, { fetchImpl })
  const roomId = await session.createRoom()
  await session.createRun(roomId, { content: prompt, model })

  const stream = await session.join(roomId, { signal })

  return new ReadableStream({
    async start(controller) {
      try {
        for await (const envelope of envelopes(stream, { signal })) {
          const { event, data } = envelope
          if (event === "assistant_message_delta") {
            const delta = data.payload?.delta ?? ""
            if (delta) controller.enqueue(openaiChunk(chunk(model, delta)))
          } else if (event === "assistant_message_finished") {
            controller.enqueue(finish(model))
          } else if (event === "run_failed" || event === "error") {
            const message = data.payload?.message ?? "Tabbit ended the run"
            throw new Error(message)
          }
        }
        controller.enqueue(finish(model))
        controller.enqueue(openaiDone())
        controller.close()
      } catch (error) {
        if (error?.name !== "AbortError") controller.error(error)
        else controller.close()
      }
    },
    cancel() {
      signal?.dispatchEvent?.(new Event("abort"))
    },
  })
}

export function assertTextOnly(body) {
  if ((Array.isArray(body?.tools) && body.tools.length > 0) || (Array.isArray(body?.functions) && body.functions.length > 0)) {
    throw new Error("Tabbit chat does not expose external tool calls; use a model with tool calling enabled")
  }
  if ((body?.tool_choice && body.tool_choice !== "none") || (body?.function_call && body.function_call !== "none")) {
    throw new Error("Tabbit chat does not support tool_choice")
  }
}

const chunk = (model, delta) => ({
  id: "chatcmpl-tabbit",
  object: "chat.completion.chunk",
  model,
  choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
})

/** The last user turn, flattened from OpenAI's content-part array. */
export function lastUserText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== "user") continue
    const { content } = message
    if (typeof content === "string") return content.trim() || null
    if (Array.isArray(content)) {
      const text = content
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n")
        .trim()
      if (text) return text
    }
  }
  return null
}

/** Preserve the caller's text history when Tabbit starts a fresh room per turn. */
export function conversationText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const lines = []
  for (const message of messages) {
    const text = messageText(message?.content)
    if (!text) continue
    const role = message.role === "system" || message.role === "developer"
      ? "Instructions"
      : message.role === "assistant"
        ? "Assistant"
        : message.role === "tool"
          ? `Tool result${message.tool_call_id ? ` (${message.tool_call_id})` : ""}`
          : "User"
    lines.push(`${role}:\n${text}`)
  }
  return lines.join("\n\n").trim() || lastUserText(body)
}

function messageText(content) {
  if (typeof content === "string") return content.trim()
  if (!Array.isArray(content)) return ""
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim()
}
