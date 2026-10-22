// Tabbit's web chat protocol, reversed from the shipped client on 2026-10-22.
//
// A turn is four steps:
//   1. POST {origin}/api/v3/chat/rooms            -> {room_id}
//   2. POST {origin}/api/v3/chat/rooms/{id}/runs  -> {run_id, status: QUEUED}
//   3. POST {origin}/api/v3/chat/rooms/{id}/join   -> SSE stream (long-lived)
//   4. read SSE until run_completed / run_failed
//
// The only credential is the httpOnly `token` cookie, a JWT whose `exp` is
// about a week out. There is no refresh endpoint, so a lapsed token means the
// user signs in again.

const REQ_CTX = "MS4xNy4xIgxMDExNzAxNig="

const json = async (response) => {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    return { _text: text.slice(0, 300) }
  }
}

const uid = () => crypto.randomUUID()

/** A room is a conversation; a run is one turn inside it. */
export class TabbitSession {
  constructor(site, { fetchImpl = fetch } = {}) {
    this.site = site
    this.fetch = fetchImpl
  }

  headers() {
    return {
      accept: "application/json",
      "content-type": "application/json",
      "x-req-ctx": REQ_CTX,
      // Tabbit rejects a run without these two, answering 429 / code 492
      "trace-id": uid(),
      "unique-uuid": uid(),
    }
  }

  async createRoom() {
    const response = await this.fetch(`${this.site.origin}/api/v3/chat/rooms`, {
      method: "POST",
      headers: this.headers(),
      body: "{}",
    })
    const data = await json(response)
    if (!response.ok) throw new Error(`${this.site.name}: create room failed (HTTP ${response.status}) ${data._text ?? ""}`)
    return data.room_id
  }

  async createRun(roomId, { content, model, parentMessageId = null }) {
    const id = uid()
    const response = await this.fetch(`${this.site.origin}/api/v3/chat/rooms/${encodeURIComponent(roomId)}/runs`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        client_run_id: `tab_${id}`,
        client_message_id: `tab_${id}`,
        agent_plan_mode_enabled: true,
        input_payload: {
          task_name: "chat",
          content,
          parent_message_id: parentMessageId,
          // The client sends an array; a bare string is refused with 429 / code 492
          selected_model: [model],
          references: [],
          metadatas: { html_content: `<p>${escapeHtml(content)}</p>` },
          page_info_list: [],
          is_mobile: false,
          agent_mode: false,
        },
      }),
    })
    const data = await json(response)
    if (!response.ok) {
      const error = new Error(`${this.site.name}: create run failed (HTTP ${response.status}) ${data.message ?? data._text ?? ""}`)
      error.status = response.status
      error.code = data.code
      throw error
    }
    return data.run_id
  }

  /** Opens the SSE stream. The caller owns the body reader. */
  async join(roomId, { signal } = {}) {
    const response = await this.fetch(`${this.site.origin}/api/v3/chat/rooms/${encodeURIComponent(roomId)}/join`, {
      method: "POST",
      headers: { ...this.headers(), accept: "text/event-stream" },
      body: JSON.stringify({
        page_instance_id: uid(),
        device_id_hash: null,
        surface: "session",
        last_event_id: null,
      }),
      signal,
    })
    if (!response.ok) throw new Error(`${this.site.name}: join failed (HTTP ${response.status})`)
    return response
  }
}

const escapeHtml = (text) =>
  String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

/** Splits an SSE body into `{event, data}` envelopes. */
export async function* envelopes(response, { signal } = {}) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    for (;;) {
      if (signal?.aborted) break
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const envelope = parseBlock(block)
        if (envelope) yield envelope
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}

function parseBlock(block) {
  let event = null
  const data = []
  for (const rawLine of block.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine
    if (line.startsWith("event:")) event = line.slice(6).trim()
    else if (line.startsWith("data:")) data.push(line.startsWith("data: ") ? line.slice(6) : line.slice(5))
  }
  if (!event || data.length === 0) return null
  try {
    return { event, data: JSON.parse(data.join("\n")) }
  } catch {
    return null
  }
}

/** The account's plan and what is left of it. */
export async function usage(site, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${site.origin}/api/v0/user/base-info`, { headers: { accept: "application/json" } })
  if (!response.ok) return { error: `HTTP ${response.status}` }
  const info = await json(response)
  const quota = await fetchImpl(
    `${site.origin}/api/commerce/quota/v1/usage?user_id=${encodeURIComponent(info.user_info?.id ?? "")}`,
    { headers: { accept: "application/json" } },
  ).then(json).catch(() => ({}))
  return {
    user: info.user_info?.secret_email || info.user_info?.secret_mobile || undefined,
    plan: quota.member_level ?? "standard",
    windows: [quotaWindow(quota)],
  }
}

function quotaWindow(quota) {
  if (quota.usage_percentage === undefined) return { name: "Weekly", used: 0 }
  const used = Number.parseFloat(quota.usage_percentage) || 0
  return {
    name: "Weekly",
    used,
    display: `${used.toFixed(2)}% of the weekly allowance`,
    resetSecs: Math.round((Number(quota.remaining_reset_hours) || 0) * 3600),
  }
}

/** The catalog for a scene: "chat" (the assistant) or "agent". */
export async function models(site, scene = "chat", { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${site.origin}/proxy/v1/model_config/models?a=0&scene=${scene}`, {
    headers: { accept: "application/json" },
  })
  if (!response.ok) return []
  const data = await json(response)
  return (data.models ?? []).map((model) => ({
    id: model.display_name,
    name: model.display_name,
    context: 0,
    image: model.supports_images === true,
    tools: model.supports_tools !== false,
    reasoning: model.support_thinking === true,
    rate: Number(model.display_multiplier) || 0,
    access: model.model_access_type,
    description: model.description,
  }))
}

// exported for tests
export { parseBlock as parseBlockForTest }
