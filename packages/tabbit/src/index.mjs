// A magpie (and OpenCode) provider plugin for the two Tabbit builds:
//   - tabbit-ai: web.tabbit.ai, the international build
//   - tabbit:    web.tabbit.com, the China build
//
// Each build becomes its own provider with its own accounts and models, the
// way WorkBuddy's two builds do. The sign-in is the browser's own `token`
// cookie, so a user signs in in Tabbit and pastes that cookie here.

import { SITES } from "./sites.mjs"
import { models as catalog, usage as quota } from "./protocol.mjs"
import { streamChatCompletion } from "./openai.mjs"

const COOKIE_HELP =
  "Open Tabbit, sign in, then copy the `token` cookie from web.tabbit.com (DevTools > Application > Cookies)."

export const TabbitAIPlugin = async ({ client }) => makePlugin(SITES["tabbit-ai"], client)
export const TabbitPlugin = async ({ client }) => makePlugin(SITES.tabbit, client)

function makePlugin(site, client) {
  return {
    config: async (config) => {
      config.provider ??= {}
      config.provider[site.id] ??= {
        name: site.name,
        npm: "@ai-sdk/openai-compatible",
        api: `${site.origin}/v1`,
        models: {},
      }
    },

    auth: {
      provider: site.id,
      maxConcurrency: 2,
      methods: [
        {
          type: "api",
          label: `${site.name} token cookie`,
          placeholder: "eyJhbGciOi...",
          async authorize(inputs) {
            const key = String(inputs?.token ?? inputs?.key ?? "").trim()
            if (!key) return { type: "failed", error: COOKIE_HELP }
            return { type: "success", key }
          },
          prompts: [{ type: "password", key: "token", message: `${site.name} token cookie`, placeholder: "eyJhbGciOi..." }],
        },
      ],

      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) return {}
        const cookie = `token=${auth.key}`
        return {
          baseURL: `${site.origin}/v1`,
          apiKey: auth.key,
          headers: { cookie },
          async fetch(input, init) {
            const url = typeof input === "string" ? input : input.url
            if (!url.includes("/chat/completions")) return fetch(input, init)
            const body = JSON.parse(typeof init.body === "string" ? init.body : "{}")
            const stream = await streamChatCompletion(site, body, {
              fetchImpl: (url, options = {}) =>
                fetch(url, { ...options, headers: { ...options.headers, cookie } }),
              signal: init.signal,
            })
            return new Response(stream, {
              status: 200,
              headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
            })
          },
        }
      },

      async usage(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) return { error: "not signed in", windows: [] }
        const result = await quota(site, {
          fetchImpl: (url, options = {}) => fetch(url, { ...options, headers: { ...options.headers, cookie: `token=${auth.key}` } }),
        })
        return { ...result, signIn: "kept" }
      },
    },

    provider: {
      id: site.id,
      async models(provider, { auth } = {}) {
        if (auth?.type !== "api" || !auth.key) return provider.models
        const fetchImpl = (url, options = {}) =>
          fetch(url, { ...options, headers: { ...options.headers, cookie: `token=${auth.key}` } })
        let list = []
        try {
          list = await catalog(site, site.scene, { fetchImpl })
        } catch {
          return provider.models
        }
        if (!list.length) return provider.models
        const base = provider.models["DeepSeek-V4.1-Flash"] ?? defaultModel(site)
        return Object.fromEntries(
          list.map((model) => [
            model.id,
            {
              ...base,
              id: model.id,
              name: model.name,
              limit: { context: model.context || 128000, output: 32000 },
              capabilities: {
                temperature: true,
                reasoning: model.reasoning,
                attachment: model.image,
                toolcall: false,
                input: { text: true, image: model.image, audio: false, video: false, pdf: false },
                output: { text: true, image: false, audio: false, video: false, pdf: false },
              },
              // magpie reads these; OpenCode ignores them
              free: model.access === "free_unlimited",
              rate: model.rate,
            },
          ]),
        )
      },
    },
  }
}

function defaultModel(site) {
  return {
    id: "DeepSeek-V4.1-Flash",
    name: "DeepSeek-V4.1-Flash",
    api: { id: "DeepSeek-V4.1-Flash", url: `${site.origin}/v1`, npm: "@ai-sdk/openai-compatible" },
    status: "active",
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  }
}

export const _internal = { makePlugin, SITES }
