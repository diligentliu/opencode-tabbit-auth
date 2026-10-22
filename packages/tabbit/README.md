# @magpie-community/opencode-tabbit-auth

Tabbit Browser's own model allowance, for every agent magpie connects.

Tabbit ships in two builds that share one protocol and one account system but
keep separate users and model catalogs. This plugin signs in to both, so each
becomes its own provider:

| Provider id | Build | Origin |
| --- | --- | --- |
| `tabbit` | Tabbit (China) | `web.tabbit.com` |
| `tabbit-ai` | Tabbit AI (international) | `web.tabbit.ai` |

## How it works

Tabbit's web client is the API. A turn is four calls, all of them plain
`fetch` with the browser's own `token` cookie:

1. `POST /api/v3/chat/rooms` - opens a room
2. `POST /api/v3/chat/rooms/{id}/runs` - submits one turn
3. `POST /api/v3/chat/rooms/{id}/join` - opens the SSE stream
4. read SSE envelopes until `run_completed`

magpie hands a plugin one API per model. This plugin declares
`@ai-sdk/openai-compatible`, so it receives chat completions and translates:
the last user message becomes the turn's `content`, and Tabbit's
`assistant_message_delta` envelopes come back as chat completion chunks.

Two request details are load-bearing and were found the hard way:

- `selected_model` must be an **array** (`["DeepSeek-V4.1-Flash"]`). A bare
  string is refused with HTTP 429 and code 492.
- `trace-id` and `unique-uuid` must both be present. Without them the same
  429 / code 492 comes back.

Neither error message says what is wrong; both read as an invitation to sign
up for Tabbit.

## Signing in

1. Open Tabbit, sign in, and open DevTools on the Tabbit page.
2. Application > Cookies > the Tabbit origin > copy the `token` cookie value.
   It is an httpOnly JWT, about a week long, with no refresh endpoint.
3. `magpie plugin login tabbit` (or `tabbit-ai`) and paste it.

The token is stored by magpie in `plugin-auth.json` (mode 600), the same place
every plugin's sign-in lives.

## Install

```bash
magpie plugin add @magpie-community/opencode-tabbit-auth
magpie plugin login tabbit
magpie plugin login tabbit-ai
```

Then any agent can use `tabbit/<model>` or `tabbit-ai/<model>`.

## Models

`provider.models` reads the account's own catalog from
`/proxy/v1/model_config/models?scene=chat`, so an account only ever serves the
models it actually has, and a free-tier account never receives a
`premium_only` model. `free` and `rate` come from the catalog's
`model_access_type` and `display_multiplier`.

## Usage

`auth.usage` reads `/api/v0/user/base-info` and
`/api/commerce/quota/v1/usage`, showing the weekly allowance used and when it
resets.

## Limits

- **No tool calls.** Tabbit's chat scene takes no tool definitions, so a
  request carrying them is refused rather than silently degraded.
- **No refresh.** The token is a week-long JWT with no refresh endpoint. When
  it lapses, copy the cookie again.
- **Text only.** Images in a user message are dropped with the rest of the
  OpenAI message shape.

## Tests

```bash
bun test            # unit tests for the SSE parser and message flattening
TABBIT_TOKEN=... TABBIT_SITE=tabbit bun scripts/live.mjs "hi"
```

`scripts/live.mjs` drives one real turn and prints the reply, which is how the
protocol details above were pinned down.
