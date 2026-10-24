# zcode-start-plan-relay

English | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

Turn the free **Start Plan** built into ZCode (Z.ai's desktop coding agent) into a
standard **Anthropic Messages-compatible endpoint** that any agent can use —
[magpie](https://github.com/yetone/magpie), Claude Code, Codex, or anything that
accepts a base URL. Single file, zero dependencies, Node 18+, cross-platform.

> ⚠️ **Use your own account and quota only.** This project is not affiliated
> with Z.ai / Zhipu / ZCode. Whether this violates their terms of service is
> for you to judge; their anti-abuse rules may change at any time, and this
> repository makes no promise of continued operation.

```
your agent ──► relay (127.0.0.1:8791) ──► https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages
                    │
                    └─ decrypts the live login JWT from ZCode's own credential
                       store on every call, and shapes the request so the
                       gateway accepts it
```

---

## Background: why Start Plan cannot be used directly

After you sign in, ZCode ships a few built-in "account" providers. One of them
is **Start Plan** (a promotional plan; `billing/current` reports
`zcode-v3-start-plan-referral`, "ZCode Global Build"). Its real upstream is:

```
POST https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages
```

Calling it yourself with a token gets rejected. There are two gates.

### Gate 1 — the token is encrypted, and the plaintext copy is stale

- The live token is `zcodejwttoken` in `~/.zcode/v2/credentials.json`, stored as
  `enc:v1:<iv>.<tag>.<data>` (base64url). Cipher: **AES-256-GCM**,
  key = `sha256(secret)` where secret is `ZCODE_CREDENTIAL_SECRET` or the
  fallback string `zcode-credential-fallback:<platform>:<homedir>:<username>`.
- The plaintext JWT in `~/.zcode/v2/config.json`
  (`builtin:bigmodel-start-plan.options.apiKey`) is a stale leftover: it is
  rejected with 401, while the decrypted live token is accepted.
- ZCode's request-signing layer (`X-Client-Sig` / `X-Client-Pow` / …) does
  **not** apply to Start Plan: ZCode's own log records
  `model.client_signing.unsigned_sent` with reason `access_mode`.

### Gate 2 — the request must look like ZCode's

With a *valid* token, a minimal request is blocked by the edge:

```
HTTP 405 {"code":3012,"msg":"request has been blocked due to unusual activity."}
```

Controlled experiments (same valid token, changing one thing at a time) give
these rules:

| Request body | Result |
|---|---|
| `messages` only | **blocked (3012)** |
| `messages` + a small system prompt | **blocked (3012)** |
| `messages` + ZCode's real 55 tools, no system | **blocked (3012)** |
| real tools + **ZCode's own system preamble** | **200 (SSE works)** |
| … plus one extra / one fewer tool | 200 |
| … with cwd/session text inside the preamble rewritten | 200 |
| `system` reduced to the first block only | **blocked (3012)** |
| `system` = first two blocks | 200 |
| caller's own system prompt **appended as one more block** | 200 (and it is obeyed) |
| text **appended into the first block** | **blocked (3012)** |

In short: **the first two blocks of ZCode's system preamble must be present
(the first block verbatim)**; tools, messages and extra system blocks are free.

### What the relay does

1. Decrypts the live token from `credentials.json` on every call (mtime-cached);
   on a 401 it force-reloads once and replays — so switching or re-logging the
   ZCode account requires **no restart** of anything.
2. Sends ZCode's two preamble blocks as `system`. The preamble is **not shipped
   with this repository** (it is Z.ai's prompt): on first start the relay
   extracts it from the local ZCode rollout logs
   (`~/.zcode/cli/rollout/model-io-*.jsonl`) and caches it next to the script.
3. Appends the caller's own system prompt as one more system block; if the edge
   rejects that shape, it automatically retries with the caller's system moved
   into the first user turn.
4. Maps `model`: the plan only serves `GLM-5.3` and `GLM-5.3-Flash`; anything
   else (e.g. a Claude model name) falls back to the default model.
5. Attaches ZCode's client headers (`user-agent: ZCode/3.16.3`,
   `x-zcode-agent: glm`, `x-zcode-app-version`, …).
6. Streams SSE (and non-streaming) straight through; tool calls work.

## Quick start

Prerequisites:

- ZCode installed, signed in, and the account actually has Start Plan
  (`~/.zcode/v2/coding-plan-cache.json` shows the entry as `available`);
- **You have sent at least one message with the Start Plan model inside ZCode**
  (ZCode then writes the model-io logs the preamble is extracted from);
- Node 18+.

```bash
node zcode-plan-relay.js
# listening on http://127.0.0.1:8791
curl http://127.0.0.1:8791/health
```

Windows convenience script (starts it hidden and prints the health):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-windows.ps1
```

On first start you should see `preamble extracted from model-io-….jsonl` — the
file `zcode-plan-preamble.json` is created next to the script (git-ignored;
do not distribute it).

### Use it from magpie

```bash
magpie provider add "ZCode Start Plan" \
  anthropic=http://127.0.0.1:8791 key=zcode-plan models=GLM-5.3,GLM-5.3-Flash
magpie claude zcode-start-plan/GLM-5.3
```

### Use it from any agent

```sh
export ANTHROPIC_BASE_URL=http://127.0.0.1:8791
export ANTHROPIC_API_KEY=whatever          # the relay ignores it unless ZCODE_PLAN_KEY is set
```

(OpenAI-shaped callers: point them at a magpie gateway that has this provider —
magpie translates between APIs — or add your own translation layer.)

### Share on the LAN / use from a Remote magpie

Expose the relay itself:

```bash
HOST=0.0.0.0 ZCODE_PLAN_KEY=<long secret> node zcode-plan-relay.js
```

…or share the whole magpie instead (the remote then gets every provider,
account and routing group; models appear as `office/zcode-start-plan/GLM-5.3`):

```bash
# this machine
magpie gateway-key add "remote"            # prints sk-magpie-key-… once
MAGPIE_ADDR=0.0.0.0:3425 magpie serve
# the other machine
magpie provider add remote-magpie sk-magpie-key-… url=http://<this-host>:3425 id=office
magpie claude office/zcode-start-plan/GLM-5.3
```

## Endpoints

| Method | Path | Description |
|---|---|---|
| POST | `/v1/messages` (also `/messages`) | Anthropic Messages, streaming and non-streaming |
| GET | `/v1/models` | model list (magpie fills its catalog from this) |
| GET | `/health` | token status, user id, model list |

## Configuration (environment variables)

| Variable | Default | Description |
|---|---|---|
| `PORT` / `HOST` | `8791` / `127.0.0.1` | listen port / address |
| `ZCODE_PLAN_MODEL` | `GLM-5.3-Flash` | fallback for unknown model names |
| `ZCODE_PLAN_KEY` | empty | if set, callers must present it (`Authorization: Bearer` or `x-api-key`); always set it when binding to a LAN |
| `ZCODE_PLAN_UPSTREAM` | `https://zcode.z.ai` | upstream origin |
| `ZCODE_PLAN_PREAMBLE` | `zcode-plan-preamble.json` next to the script | preamble cache location |
| `ZCODE_PLAN_ROLLOUT` | `~/.zcode/cli/rollout` | logs scanned for preamble extraction |
| `ZCODE_PLAN_LOG` | `%TEMP%\zcode-plan-relay.log` | log file |
| `ZCODE_PLAN_VERBOSE` | off | set `1` to also log to stdout |
| `ZCODE_CREDENTIAL_SECRET` | fallback string | ZCode's credential secret (normally leave unset) |

## Limitations and known issues

- The plan only serves `GLM-5.3` and `GLM-5.3-Flash`; other model names are
  rejected upstream (`3006 model not allowed`) or mapped to the default.
- The system prompt is dominated by ZCode's: its preamble is always present and
  the caller's instructions ride as an extra block (demonstrated to be obeyed,
  but it is not a native system role).
- Quota is spent on your own Start Plan — a promotional plan with an expiry and
  limited allowance.
- Gate 2 is behavioural, not a fixed checksum; Z.ai can change it at any time
  and the relay may stop working.
- The relay keeps the caller's `tools` and conversation intact, but always adds
  `thinking` and `output_config` defaults matching ZCode's own requests.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `/health` shows `token.ok: false` | ZCode is not signed in / credentials file missing — sign in inside ZCode |
| startup log: `preamble not extracted` | use the Start Plan model once inside ZCode, then restart the relay |
| `upstream 405 … 3012` | the shape was rejected: the preamble file is probably damaged (first block must stay verbatim) |
| `upstream 400 … model not allowed` | a model outside the plan was requested |
| repeated 401 | the token is truly invalid: re-login in ZCode; the relay re-reads automatically |

## How it was reverse engineered (short version)

1. Static analysis of ZCode's packaged CLI (`resources/glm/zcode.cjs`): the
   plan endpoint constants, the credential cipher
   (`createZCodeCredentialCipher`), and the client-signing layer with its
   `access_mode` skip for this plan.
2. ZCode's own model-io rollout logs (`~/.zcode/cli/rollout/*.jsonl`): the full
   shape of real requests (auth headers scrubbed by ZCode itself, everything
   else intact).
3. Controlled experiments against the upstream (one valid token, adding and
   removing one request component at a time) → the gate matrix above.
4. magpie's docs and source confirmed the custom-provider (`anthropic=`) and
   Remote magpie mechanisms used on the consuming side.

## Repository layout

| Path | Purpose |
|---|---|
| `zcode-plan-relay.js` | the relay (single file, no dependencies) |
| `scripts/start-windows.ps1` | start it hidden on Windows and print the health |
| `zcode-plan-preamble.json` | generated locally on first start — **never commit or share it** |

## License

[MIT](LICENSE)
