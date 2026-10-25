// zcode-start-plan-relay — turn ZCode's free "Start Plan" into an
// Anthropic-compatible endpoint any agent can use (magpie, Claude Code, ...).
//
// Upstream:
//   POST https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages
//
// Two gates have to be satisfied:
//   1. Authorization: Bearer <zcode login JWT>. The live one lives encrypted
//      ("enc:v1:<iv>.<tag>.<data>", aes-256-gcm) in ~/.zcode/v2/credentials.json
//      as "zcodejwttoken". The relay decrypts it per call (mtime-cached) and
//      force-reloads once on a 401, so account switches need no restart.
//   2. The request must look like ZCode's own: its system preamble (the first
//      two blocks of its prompt) has to be present, or the edge answers
//      HTTP 405 {"code":3012,"msg":"request has been blocked due to unusual
//      activity."}. Tools, messages and extra system blocks are free; the
//      caller's own system prompt rides as one more system block.
//
// The preamble is Z.ai's prompt, so it is NOT shipped with this repository:
// on first start the relay extracts it from the local ZCode rollout logs
// (~/.zcode/cli/rollout/model-io-*.jsonl) and caches it next to this file.
//
// Endpoints: POST /v1/messages (Anthropic), GET /v1/models, GET /health.
// Node 18+, no dependencies. See README.md for usage and the risk notes.
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { URL } = require('url');

const listenHost = process.env.HOST || '127.0.0.1';
const listenPort = Number(process.env.PORT || 8791);
const upstreamOrigin = process.env.ZCODE_PLAN_UPSTREAM || 'https://zcode.z.ai';
const planPath = '/api/v1/zcode-plan/anthropic';
const stateRoot = path.join(process.env.USERPROFILE || os.homedir(), '.zcode', 'v2');
const credentialsPath = path.join(stateRoot, 'credentials.json');
const logPath = process.env.ZCODE_PLAN_LOG || path.join(os.tmpdir(), 'zcode-plan-relay.log');
const preamblePath = process.env.ZCODE_PLAN_PREAMBLE || path.join(__dirname, 'zcode-plan-preamble.json');
const rolloutDirPath = process.env.ZCODE_PLAN_ROLLOUT || path.join(process.env.USERPROFILE || os.homedir(), '.zcode', 'cli', 'rollout');

const allowedModels = new Set(['glm-5.3', 'glm-5.3-flash']);
const defaultModel = process.env.ZCODE_PLAN_MODEL || 'GLM-5.3-Flash';
const maxOutputCap = 128000; // ZCode's own ceiling on this plan
// Set when the relay is reachable from other machines; empty means no check.
const relayKey = (process.env.ZCODE_PLAN_KEY || '').trim();

function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  try { fs.appendFileSync(logPath, line); } catch {}
  if (process.env.ZCODE_PLAN_VERBOSE) process.stdout.write(line);
}

// ---- ZCode credential -------------------------------------------------------
const ENC_PREFIX = 'enc:v1:';

function credentialSecret() {
  if (process.env.ZCODE_CREDENTIAL_SECRET) return process.env.ZCODE_CREDENTIAL_SECRET;
  let user = 'unknown';
  try { user = os.userInfo().username; } catch {}
  return `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${user}`;
}

function decryptCredential(value) {
  const [iv, tag, data] = value.slice(ENC_PREFIX.length).split('.');
  const key = crypto.createHash('sha256').update(credentialSecret()).digest();
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
}

let cachedToken = { value: '', mtimeMs: 0 };

function liveToken(force = false) {
  let stat;
  try { stat = fs.statSync(credentialsPath); } catch (e) {
    throw new Error(`cannot read ZCode credentials at ${credentialsPath}: ${e.message}`);
  }
  if (!force && cachedToken.value && stat.mtimeMs === cachedToken.mtimeMs) return cachedToken.value;
  const store = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  const raw = store.zcodejwttoken;
  if (typeof raw !== 'string' || !raw) throw new Error('zcodejwttoken is missing; sign in to ZCode first');
  const token = raw.startsWith(ENC_PREFIX) ? decryptCredential(raw) : raw;
  cachedToken = { value: token, mtimeMs: stat.mtimeMs };
  log(`credential reloaded (issued ${new Date(jwtIssuedAt(token) * 1000).toISOString()})`);
  return token;
}

function jwtPayload(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8')); } catch { return {}; }
}
function jwtIssuedAt(token) { return Number(jwtPayload(token).iat || 0); }

// ---- ZCode's client identity ------------------------------------------------
function clientHeaders(token, beta) {
  const headers = {
    authorization: `Bearer ${token}`,
    'user-agent': 'ZCode/3.16.3',
    'http-referer': upstreamOrigin,
    'x-zcode-app-version': '3.16.3',
    'x-title': 'Z Code@electron',
    'x-release-channel': 'production',
    'x-client-language': 'zh-CN',
    'x-client-timezone': 'Asia/Shanghai',
    'x-zcode-agent': 'glm',
    'x-platform': 'win32-x64',
    'x-os-category': 'windows',
    'x-os-version': '10.0.26200',
    'x-request-id': crypto.randomUUID(),
    'x-zcode-trace-id': crypto.randomUUID(),
    'x-query-id': crypto.randomUUID(),
    'x-zcode-query-source': 'main_turn',
    'x-session-id': `session_${crypto.randomUUID().replace(/-/g, '')}`,
    'x-zcode-session-type': 'main',
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  };
  // keep the caller's beta list (e.g. context-1m) instead of dropping it
  if (beta) headers['anthropic-beta'] = beta;
  return headers;
}

// ---- ZCode's system preamble ------------------------------------------------
let preamble = null;

function loadPreamble() {
  if (preamble) return preamble;
  try {
    const blocks = JSON.parse(fs.readFileSync(preamblePath, 'utf8'));
    preamble = blocks.filter((b) => typeof b === 'string' && b.trim());
    log(`preamble loaded (${preamble.length} blocks) from ${preamblePath}`);
  } catch (e) {
    log(`preamble unavailable (${preamblePath}): ${e.message}`);
    preamble = [];
  }
  return preamble;
}

// The preamble is extracted from the user's own ZCode rollout logs: ZCode
// writes every model request (auth headers scrubbed) to model-io-*.jsonl, and
// a Start Plan record carries exactly the system blocks the gate wants.
function findPreambleRecord(file) {
  return new Promise((resolve) => {
    let preferred = null;
    let generic = null;
    const rl = readline.createInterface({
      input: fs.createReadStream(file, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    rl.on('line', (line) => {
      if (preferred) { rl.close(); return; }
      let rec;
      try { rec = JSON.parse(line); } catch { return; }
      const body = rec && rec.request && rec.request.body;
      if (!body || !Array.isArray(body.system) || body.system.length < 2) return;
      if (!Array.isArray(body.tools) || !body.tools.length) return;
      const blocks = body.system
        .filter((b) => b && typeof b.text === 'string' && b.text.trim())
        .slice(0, 2)
        .map((b) => b.text);
      if (blocks.length < 2) return;
      const candidate = { blocks };
      const pid = (rec.model && rec.model.providerId) || '';
      if (/start-plan/i.test(pid)) preferred = candidate;
      else if (!generic) generic = candidate;
    });
    rl.on('close', () => resolve(preferred || generic));
    rl.on('error', () => resolve(preferred || generic));
  });
}

async function ensurePreamble() {
  if (fs.existsSync(preamblePath)) return;
  let files = [];
  try {
    files = fs.readdirSync(rolloutDirPath).filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ f, m: fs.statSync(path.join(rolloutDirPath, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
      .slice(0, 5)
      .map((x) => path.join(rolloutDirPath, x.f));
  } catch (e) {
    log(`no ZCode rollout logs at ${rolloutDirPath}: ${e.message}`);
  }
  for (const file of files) {
    const rec = await findPreambleRecord(file);
    if (!rec) continue;
    preamble = rec.blocks;
    try {
      fs.writeFileSync(preamblePath, JSON.stringify(preamble, null, 1));
      log(`preamble extracted from ${path.basename(file)} and cached at ${preamblePath}`);
    } catch (e) {
      log(`preamble extracted from ${path.basename(file)} (kept in memory only: ${e.message})`);
    }
    return;
  }
  log('preamble not extracted: use the Start Plan model once inside ZCode (it writes model-io logs), then restart the relay');
}

// ---- Request rewriting ------------------------------------------------------
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n\n');
}

function mapModel(model) {
  const wanted = typeof model === 'string' ? model.trim() : '';
  if (!wanted) return defaultModel;
  const bare = wanted.includes('/') ? wanted.slice(wanted.lastIndexOf('/') + 1) : wanted;
  const clean = bare.replace(/\[[^\]]*\]$/, '').trim();
  return allowedModels.has(clean.toLowerCase()) ? clean : defaultModel;
}

// Two shapes are built for every request: the caller's system as one more
// system block (keeps the system role), and — should the edge turn that down —
// the caller's system moved into the first user turn.
function buildVariants(raw) {
  const body = JSON.parse(raw.toString('utf8'));
  const blocks = loadPreamble();
  const callerSystem = textOf(body.system);
  const messages = Array.isArray(body.messages) ? body.messages.map((m) => ({ ...m })) : [];

  const shared = {
    model: mapModel(body.model),
    max_tokens: Math.min(Number(body.max_tokens) || 8192, maxOutputCap),
    stream: body.stream !== false,
  };
  if (Array.isArray(body.tools) && body.tools.length) shared.tools = body.tools;
  if (body.tool_choice) shared.tool_choice = body.tool_choice;
  if (body.stop_sequences) shared.stop_sequences = body.stop_sequences;
  if (body.temperature !== undefined) shared.temperature = body.temperature;
  if (body.top_p !== undefined) shared.top_p = body.top_p;
  // Pass the caller's reasoning config through as-is. Injecting ZCode's own
  // defaults here (thinking enabled + effort max) was measured to add 1.2s+
  // of reasoning latency to callers that never asked for it.
  if (body.thinking && typeof body.thinking === 'object') shared.thinking = body.thinking;
  if (body.output_config && typeof body.output_config === 'object') shared.output_config = body.output_config;
  shared.metadata = { user_id: jwtPayload(liveToken()).user_id || '' };

  const asBlocks = blocks.map((text) => ({ type: 'text', text }));
  if (callerSystem) asBlocks.push({ type: 'text', text: callerSystem });

  const variants = [{
    name: 'system-block',
    body: Buffer.from(JSON.stringify({ ...shared, system: asBlocks.length ? asBlocks : undefined, messages })),
  }];

  if (callerSystem) {
    const hoisted = messages.map((m) => ({ ...m }));
    const block = { type: 'text', text: `<caller_instructions>\n${callerSystem}\n</caller_instructions>` };
    const firstUser = hoisted.findIndex((m) => m.role === 'user');
    if (firstUser === -1) hoisted.unshift({ role: 'user', content: [block] });
    else if (typeof hoisted[firstUser].content === 'string') {
      hoisted[firstUser] = { role: 'user', content: [block, { type: 'text', text: hoisted[firstUser].content }] };
    } else if (Array.isArray(hoisted[firstUser].content)) {
      hoisted[firstUser] = { role: 'user', content: [block, ...hoisted[firstUser].content] };
    }
    variants.push({
      name: 'user-turn',
      body: Buffer.from(JSON.stringify({ ...shared, system: blocks.map((text) => ({ type: 'text', text })), messages: hoisted })),
    });
  }

  return { variants, model: shared.model, stream: shared.stream, callerSystem: !!callerSystem };
}

// ---- Forwarding -------------------------------------------------------------
const upstream = new URL(upstreamOrigin);
const transport = upstream.protocol === 'http:' ? http : https;
// Reuse TLS connections across requests instead of re-handshaking per call.
const keepAliveAgent = upstream.protocol === 'http:'
  ? new http.Agent({ keepAlive: true, maxSockets: 32 })
  : new https.Agent({ keepAlive: true, maxSockets: 32 });

function forward(variants, index, token, res, { tokenRetried = false, beta = '' } = {}) {
  const variant = variants[index];
  const headers = { ...clientHeaders(token, beta), 'content-length': Buffer.byteLength(variant.body) };

  const out = transport.request({
    protocol: upstream.protocol,
    hostname: upstream.hostname,
    port: upstream.port || (upstream.protocol === 'http:' ? 80 : 443),
    method: 'POST',
    path: `${planPath}/v1/messages`,
    headers,
    agent: keepAliveAgent,
  }, (up) => {
    const status = up.statusCode || 502;

    // A rotated credential: reload once and replay.
    if (status === 401 && !tokenRetried) {
      up.resume();
      log('upstream 401; reloading the credential and retrying once');
      let fresh;
      try {
        fresh = liveToken(true);
      } catch (e) {
        log(`credential reload failed: ${e.message}`);
        if (!res.headersSent) res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'no_credential', message: e.message } }));
        return;
      }
      forward(variants, index, fresh, res, { tokenRetried: true, beta });
      return;
    }

    if (status === 200) {
      res.writeHead(status, up.headers);
      up.pipe(res);
      up.on('end', () => log(`ok ${variant.name} ${variant.body.length}B`));
      return;
    }

    // Any failure is buffered: a 3012 here means "not ZCode-shaped", so try
    // the next shape before giving up.
    const chunks = [];
    up.on('data', (c) => chunks.push(c));
    up.on('end', () => {
      const body = Buffer.concat(chunks);
      const text = body.toString('utf8');
      const blocked = status === 405 && text.includes('3012');
      if (blocked && index + 1 < variants.length) {
        log(`blocked (3012) on ${variant.name}; retrying with ${variants[index + 1].name}`);
        forward(variants, index + 1, token, res, { tokenRetried, beta });
        return;
      }
      log(`upstream ${status} on ${variant.name}: ${text.slice(0, 240).replace(/\s+/g, ' ')}`);
      if (!res.headersSent) res.writeHead(status, up.headers);
      res.end(body);
    });
  });

  out.on('error', (e) => {
    log(`upstream error: ${e.message}`);
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'relay_error', message: e.message } }));
  });
  out.end(variant.body);
}

// ---- Server -----------------------------------------------------------------
const server = http.createServer((req, res) => {
  const url = req.url || '/';

  if (url === '/health' || url === '/') {
    const status = { ok: true, upstream: upstreamOrigin, defaultModel, models: [...allowedModels] };
    try {
      const token = liveToken();
      status.token = { ok: true, user: jwtPayload(token).user_id, issuedAt: jwtIssuedAt(token) };
    } catch (e) {
      status.ok = false;
      status.token = { ok: false, error: e.message };
    }
    res.writeHead(status.ok ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify(status));
    return;
  }

  if (/^\/v1?\/models\/?$/.test(url)) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: [...allowedModels].map((id) => ({ id, object: 'model', type: 'model', display_name: id, owned_by: 'zcode-start-plan', created: 0 })),
    }));
    return;
  }

  if (!/^\/v1\/messages\/?$/.test(url) && !/^\/messages\/?$/.test(url)) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'not_found', message: `no route ${url}` } }));
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'method_not_allowed' } }));
    return;
  }
  // Optional shared secret, for when the relay is reachable from other
  // machines (HOST=0.0.0.0). Without it, a loopback-only relay needs none.
  if (relayKey) {
    const given = String(req.headers['x-api-key'] || req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (given !== relayKey) {
      log('rejected: wrong relay key');
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'unauthorized', message: 'relay key mismatch' } }));
      return;
    }
  }

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    let token;
    try {
      token = liveToken();
    } catch (e) {
      log(`no credential: ${e.message}`);
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'no_credential', message: e.message } }));
      return;
    }

    let prepared;
    try {
      prepared = buildVariants(raw);
    } catch (e) {
      log(`bad request body: ${e.message}`);
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request', message: e.message } }));
      return;
    }

    log(`${req.method} ${url} model->${prepared.model} stream=${prepared.stream} callerSystem=${prepared.callerSystem} ${prepared.variants[0].body.length}B`);
    forward(prepared.variants, 0, token, res, { beta: String(req.headers['anthropic-beta'] || '') });
  });
});

server.on('error', (e) => {
  log(`server error: ${e.message}`);
  process.exit(e.code === 'EADDRINUSE' ? 0 : 1);
});

(async () => {
  await ensurePreamble();
  server.listen(listenPort, listenHost, () => {
    const lines = [
      `listening on http://${listenHost}:${listenPort}`,
      `  upstream  : ${upstreamOrigin}${planPath}/v1/messages`,
      `  models    : ${[...allowedModels].join(', ')} (others -> ${defaultModel})`,
      `  preamble  : ${loadPreamble().length} blocks${fs.existsSync(preamblePath) ? '' : ' (in memory only)'}`,
      `  auth      : ${relayKey ? 'shared key required (ZCODE_PLAN_KEY)' : 'none (loopback only)'}`,
      `  log       : ${logPath}`,
    ];
    try {
      const token = liveToken();
      lines.push(`  credential: ok (user ${jwtPayload(token).user_id}, issued ${new Date(jwtIssuedAt(token) * 1000).toISOString()})`);
    } catch (e) {
      lines.push(`  credential: NOT usable — ${e.message}`);
    }
    for (const l of lines) console.log(l);
    log(lines[0]);
  });
})();
