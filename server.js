// Flightdeck — Recall.ai bot observability and webhook debugger.
// Node 18+, zero runtime dependencies. Run with: node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function loadEnv(file = path.join(__dirname, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[2].startsWith('#') || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
loadEnv();

const PORT = Number(process.env.PORT || 3000);
const KEY = process.env.RECALL_API_KEY || '';
const REGION = process.env.RECALL_REGION || 'us-east-1';
const WHSEC = process.env.RECALL_WEBHOOK_SECRET || '';
const LIVE = Boolean(KEY);
const DATA_DIR = process.env.FLIGHTDECK_DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'flightdeck.json');
const DEMO_SECRET = process.env.FLIGHTDECK_DEMO_SECRET || 'whsec_flightdeck_demo';
const MAX_BODY = 1024 * 1024;
const bots = new Map();
const deliveries = [];
const clients = new Set();
const seen = new Set();
let mode = 'healthy';

const uid = prefix => `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const now = () => Date.now();
const platformOf = url => /zoom\./i.test(url) ? 'zoom' : /meet\.google/i.test(url) ? 'google_meet' : /teams\./i.test(url) ? 'microsoft_teams' : 'unknown';
const emit = (type, data) => {
  const message = `data: ${JSON.stringify({ type, data })}\n\n`;
  for (const client of clients) {
    try { client.write(message); } catch { clients.delete(client); }
  }
};

const PEOPLE = ['Aarav Mehta', 'Meera Iyer', 'Daniel Cho', 'Priya Nair'];
const SCRIPT = [
  [[0, "Alright, thanks everyone for joining. Let's start with the Q3 onboarding numbers."]],
  [[1, 'Activation is up 12% since we shipped the guided setup.']],
  [[2, 'Which is great, but support tickets about calendar sync are also up.']],
  [[0, 'Can we look at the sync failures first, because that is blocking —'], [3, 'Yes, I pulled the logs this morning, mostly Outlook tokens.']],
  [[3, 'Expired refresh tokens. I can have a fix in review by Thursday.']],
  [[0, 'Perfect. Daniel, can you own the customer comms?']],
  [[2, 'On it. I will send an update to affected accounts tomorrow.']],
  [[1, 'Action items: token fix Thursday, comms tomorrow, revisit on Monday.']],
];
const DIAG = {
  timeout_exceeded_waiting_room: { cause: 'The host never admitted the bot before the waiting-room timeout.', fix: 'Ask the host to admit the bot, enable lobby-bypass for your org, or raise automatic_leave.waiting_room_timeout.', severity: 'config' },
  recording_permission_denied: { cause: 'The host declined the recording request, so the bot could join but not record.', fix: 'Show a consent message before the call, or send a chat message explaining why the bot is recording.', severity: 'consent' },
  meeting_not_found: { cause: 'The meeting URL did not resolve to a live meeting.', fix: 'Check the URL and meeting state, then schedule from calendar data so the link stays fresh.', severity: 'input' },
  api_error: { cause: 'Flightdeck could not create or retrieve the bot through the Recall API.', fix: 'Check RECALL_API_KEY, RECALL_REGION, API permissions, and the meeting URL. The server error is recorded with the bot.', severity: 'config' },
};

function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const snapshot = {
    bots: [...bots.values()],
    deliveries: deliveries.slice(0, 250),
    seen: [...seen].slice(-5000),
  };
  const temp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(snapshot, null, 2));
  fs.renameSync(temp, DATA_FILE);
}
function restore() {
  if (!fs.existsSync(DATA_FILE)) return;
  try {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const bot of saved.bots || []) bots.set(bot.id, bot);
    deliveries.push(...(saved.deliveries || []));
    for (const id of saved.seen || []) seen.add(id);
  } catch (error) {
    console.error(`Could not restore ${DATA_FILE}: ${error.message}`);
  }
}

async function recall(pathname, options = {}) {
  if (!KEY) throw new Error('RECALL_API_KEY is not configured');
  const response = await fetch(`https://${REGION}.recall.ai/api/v1${pathname}`, {
    ...options,
    headers: { Authorization: `Token ${KEY}`, 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new Error(`Recall ${response.status}: ${typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300)}`);
  return body;
}

function pub(bot) {
  return {
    id: bot.id, recall_id: bot.recall_id || null, bot_name: bot.bot_name,
    meeting_url: bot.meeting_url, platform: bot.platform, scenario: bot.scenario,
    status: bot.status, sub_code: bot.sub || null, created_at: bot.created,
    status_changes: bot.events || [], lines: (bot.transcript || []).length,
    webhook_count: bot.webhook_count || 0, error: bot.error || null,
  };
}
function newBot(url, name, scenario, metadata = {}) {
  const bot = {
    id: uid('bot'), bot_name: name || 'Flightdeck Notetaker', meeting_url: url,
    platform: platformOf(url), scenario, status: 'ready', sub: null,
    created: now(), events: [], transcript: [], metadata, webhook_count: 0,
  };
  bots.set(bot.id, bot);
  persist();
  return bot;
}
function addStatus(bot, code, sub, at, source = 'simulated') {
  if (!code) return;
  const event = { code, sub_code: sub || null, created_at: at || now(), source };
  const last = bot.events[bot.events.length - 1];
  if (last && last.code === event.code && last.sub_code === event.sub_code && Math.abs(last.created_at - event.created_at) < 1000) return;
  bot.events.push(event);
  bot.status = code;
  bot.sub = event.sub_code;
  bot.updated = now();
  persist();
  emit('bot', pub(bot));
  if (!LIVE) dispatchDemo(bot, event);
}
function addLine(bot, speaker, text, t, overlap = false) {
  const speakerId = Math.max(0, PEOPLE.indexOf(speaker));
  const line = { id: uid('ln'), speaker, speaker_id: speakerId, text, t: Number(t) || 0, overlap };
  bot.transcript.push(line);
  persist();
  emit('line', { bot_id: bot.id, line });
}
async function runDemo(bot) {
  const step = async (code, ms, sub) => { await sleep(ms); addStatus(bot, code, sub); };
  await step('joining_call', 500);
  if (bot.scenario === 'bad_link') return step('fatal', 900, 'meeting_not_found');
  await step('in_waiting_room', 1200);
  if (bot.scenario === 'waiting_room') return step('fatal', 3500, 'timeout_exceeded_waiting_room');
  await step('in_call_not_recording', 1300);
  if (bot.scenario === 'denied') return step('fatal', 1800, 'recording_permission_denied');
  await step('recording_permission_allowed', 800);
  await step('in_call_recording', 600);
  let t = 0;
  for (const group of SCRIPT) {
    await sleep(1300);
    for (const [speaker, text] of group) addLine(bot, PEOPLE[speaker], text, t, group.length > 1);
    t += 6;
  }
  await step('call_ended', 900);
  await step('done', 1000);
}

function findDownloadUrl(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.download_url === 'string') return value.download_url;
  for (const child of Object.values(value)) {
    const found = findDownloadUrl(child);
    if (found) return found;
  }
  return null;
}
function normalizeTranscript(items) {
  if (!Array.isArray(items)) return [];
  const names = new Map();
  const lines = [];
  for (const item of items) {
    const speaker = item.participant?.name || item.speaker?.name || item.speaker || 'Unknown';
    const words = Array.isArray(item.words) ? item.words : [];
    const text = item.text || words.map(word => word.text).join(' ');
    if (!text) continue;
    if (!names.has(speaker)) names.set(speaker, names.size % 4);
    const first = words[0]?.start_timestamp;
    const t = typeof first === 'object' ? first.relative : first;
    lines.push({ id: uid('ln'), speaker, speaker_id: names.get(speaker), text, t: Number(t) || 0, overlap: false });
  }
  return lines.sort((a, b) => a.t - b.t);
}
async function loadLiveTranscript(bot, response) {
  try {
    const url = findDownloadUrl(response?.recordings?.[0]?.media_shortcuts?.transcript)
      || findDownloadUrl(response?.recordings?.[0]?.transcript);
    if (!url) return;
    const transcriptResponse = await fetch(url);
    if (!transcriptResponse.ok) throw new Error(`Transcript download returned ${transcriptResponse.status}`);
    bot.transcript = normalizeTranscript(await transcriptResponse.json());
    bot.transcript_loaded_at = now();
    persist();
    emit('bot', pub(bot));
  } catch (error) {
    bot.error = `Transcript: ${error.message}`;
    persist();
    emit('bot', pub(bot));
  }
}
async function createLiveBot(bot) {
  try {
    const response = await recall('/bot/', {
      method: 'POST',
      body: JSON.stringify({
        meeting_url: bot.meeting_url,
        bot_name: bot.bot_name,
        metadata: { ...bot.metadata, flightdeck_id: bot.id },
        recording_config: { transcript: { provider: { recallai_streaming: { mode: 'prioritize_low_latency', language_code: 'en' } } } },
      }),
    });
    bot.recall_id = response.id;
    bot.recall_response = { id: response.id, join_at: response.join_at || null };
    persist();
    addStatus(bot, 'joining_call', null, now(), 'recall_api');
  } catch (error) {
    bot.error = error.message;
    persist();
    addStatus(bot, 'fatal', 'api_error', now(), 'flightdeck');
  }
}

function header(req, key) {
  return req.headers[`webhook-${key}`] || req.headers[`svix-${key}`] || '';
}
function secretBytes(secret) {
  const value = secret.replace(/^whsec_/, '');
  try { return Buffer.from(value, 'base64'); } catch { return Buffer.from(secret); }
}
function verifyRecallSignature(req, raw) {
  if (!WHSEC) return { ok: false, reason: 'RECALL_WEBHOOK_SECRET is not configured' };
  const id = header(req, 'id');
  const timestamp = header(req, 'timestamp');
  const signatures = header(req, 'signature').split(' ').map(value => value.split(',')[1]).filter(Boolean);
  const age = Math.abs(Math.floor(now() / 1000) - Number(timestamp));
  if (!id || !timestamp || !signatures.length || !Number.isFinite(age) || age > 300) return { ok: false, reason: 'missing or stale webhook headers' };
  const expected = crypto.createHmac('sha256', secretBytes(WHSEC)).update(`${id}.${timestamp}.${raw}`).digest('base64');
  const ok = signatures.some(signature => {
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
  return { ok, reason: ok ? null : 'invalid webhook signature' };
}
function normalizedRecallEvent(payload) {
  const raw = payload?.data?.data || payload?.data?.status || payload?.status || {};
  const bot = payload?.data?.bot || payload?.bot || {};
  const eventName = payload?.event || '';
  return {
    event: eventName,
    code: raw.code || eventName.replace(/^bot\./, ''),
    sub_code: raw.sub_code || null,
    created_at: Date.parse(raw.updated_at || payload.created_at || '') || now(),
    recall_id: bot.id || payload?.data?.bot_id || payload?.bot_id || null,
  };
}
function recallWebhook(req, res, raw) {
  const verification = verifyRecallSignature(req, raw);
  let payload = {};
  try { payload = JSON.parse(raw); } catch { return json(res, 400, { error: 'invalid JSON' }); }
  const eventId = header(req, 'id') || uid('evt');
  const normalized = normalizedRecallEvent(payload);
  const delivery = {
    id: uid('dlv'), eventId, event: normalized.event || `bot.${normalized.code}`,
    botId: normalized.recall_id || '—', payload, attempts: [{ n: 1, status: verification.ok ? 200 : 401, error: verification.reason, ms: 0, at: now() }],
    state: verification.ok ? 'delivered' : 'failed', created: now(), live: true, signature: verification.ok ? 'verified' : verification.reason,
  };
  deliveries.unshift(delivery);
  if (deliveries.length > 250) deliveries.pop();
  if (verification.ok && !seen.has(eventId)) {
    seen.add(eventId);
    const bot = [...bots.values()].find(item => item.recall_id === normalized.recall_id);
    if (bot) {
      bot.webhook_count = (bot.webhook_count || 0) + 1;
      addStatus(bot, normalized.code, normalized.sub_code, normalized.created_at, 'recall_webhook');
      if (normalized.code === 'done') recall(`/bot/${bot.recall_id}/`).then(response => loadLiveTranscript(bot, response)).catch(error => { bot.error = error.message; persist(); emit('bot', pub(bot)); });
    }
  }
  persist();
  emit('delivery', delivery);
  emit('stats', stats());
  return json(res, verification.ok ? 200 : 401, { ok: verification.ok, error: verification.reason || undefined });
}

function demoSignature(id, timestamp, body) {
  return `v1,${crypto.createHmac('sha256', DEMO_SECRET).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}
function dispatchDemo(bot, event) {
  const payload = { event: `bot.${event.code}`, data: { bot_id: bot.id, status: { code: event.code, sub_code: event.sub_code, updated_at: new Date(event.created_at).toISOString() } } };
  const delivery = { id: uid('dlv'), eventId: uid('evt'), event: payload.event, botId: bot.id, payload, attempts: [], state: 'pending', created: now() };
  deliveries.unshift(delivery);
  if (deliveries.length > 250) deliveries.pop();
  deliverDemo(delivery);
}
async function deliverDemo(delivery) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt) await sleep(700 * 2 ** (attempt - 1));
    const timestamp = Math.floor(now() / 1000), body = JSON.stringify(delivery.payload), started = now();
    let status = 0, error = null;
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/hooks/demo`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'webhook-id': delivery.eventId, 'webhook-timestamp': String(timestamp), 'webhook-signature': demoSignature(delivery.eventId, timestamp, body) } });
      status = response.status;
    } catch (e) { error = e.message; }
    delivery.attempts.push({ n: attempt + 1, status, error, ms: now() - started, at: now() });
    delivery.state = status >= 200 && status < 300 ? 'delivered' : attempt === 3 ? 'failed' : 'retrying';
    persist();
    emit('delivery', delivery);
    if (delivery.state === 'delivered') break;
  }
  emit('stats', stats());
}
function demoReceiver(req, res, raw) {
  const id = req.headers['webhook-id'], timestamp = req.headers['webhook-timestamp'];
  if (req.headers['webhook-signature'] !== demoSignature(id, timestamp, raw)) return json(res, 401, { error: 'bad signature' });
  if (Math.abs(now() / 1000 - Number(timestamp)) > 300) return json(res, 400, { error: 'stale timestamp' });
  if (seen.has(id)) return json(res, 200, { duplicate: true });
  if (mode === 'down') return json(res, 503, { error: 'service unavailable' });
  if (mode === 'flaky' && Math.random() < 0.6) return json(res, 500, { error: 'transient failure' });
  seen.add(id); persist(); return json(res, 200, { ok: true });
}
function stats() {
  const all = [...bots.values()], finished = all.filter(bot => ['done', 'fatal'].includes(bot.status));
  const delivered = deliveries.filter(item => ['delivered', 'failed'].includes(item.state));
  const durations = all.map(bot => {
    const start = bot.events.find(event => event.code === 'joining_call');
    const recording = bot.events.find(event => event.code === 'in_call_recording');
    return start && recording ? recording.created_at - start.created_at : null;
  }).filter(Boolean).sort((a, b) => a - b);
  return {
    total: all.length, active: all.length - finished.length,
    success_rate: finished.length ? finished.filter(bot => bot.status === 'done').length / finished.length : null,
    delivery_rate: delivered.length ? delivered.filter(item => item.state === 'delivered').length / delivered.length : null,
    retries: deliveries.reduce((sum, item) => sum + Math.max(0, item.attempts.length - 1), 0),
    median_join_ms: durations.length ? durations[Math.floor(durations.length / 2)] : null,
    receiver: mode, live: LIVE, region: REGION, webhook_configured: Boolean(WHSEC),
  };
}
function seed() {
  if (bots.size) return;
  const create = (url, scenario, codes, sub, minutes) => {
    const bot = newBot(url, 'Flightdeck Notetaker', scenario);
    bot.created = now() - minutes * 60000;
    for (const code of codes) bot.events.push({ code, sub_code: code === 'fatal' ? sub : null, created_at: bot.created + 1400 });
    bot.status = codes[codes.length - 1]; bot.sub = sub || null;
    if (bot.status === 'done') SCRIPT.forEach((group, index) => group.forEach(([speaker, text]) => bot.transcript.push({ id: uid('ln'), speaker: PEOPLE[speaker], speaker_id: speaker, text, t: index * 6, overlap: group.length > 1 })));
    persist();
  };
  seed._created = true;
  create('https://zoom.us/j/84920137561', 'normal', ['joining_call', 'in_waiting_room', 'in_call_not_recording', 'recording_permission_allowed', 'in_call_recording', 'call_ended', 'done'], null, 42);
  create('https://meet.google.com/abc-defg-hij', 'waiting_room', ['joining_call', 'in_waiting_room', 'fatal'], 'timeout_exceeded_waiting_room', 25);
  create('https://teams.microsoft.com/l/meetup-join/19%3ameeting', 'normal', ['joining_call', 'in_waiting_room', 'in_call_not_recording', 'recording_permission_allowed', 'in_call_recording', 'call_ended', 'done'], null, 11);
}
function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
function readBody(req, callback) {
  let raw = '', tooLarge = false;
  req.on('data', chunk => { raw += chunk; if (raw.length > MAX_BODY) tooLarge = true; });
  req.on('end', () => tooLarge ? callback(null, new Error('request body too large')) : callback(raw, null));
}

restore();
if (!LIVE) seed();
const server = http.createServer((req, res) => {
  readBody(req, (raw, bodyError) => {
    if (bodyError) return json(res, 413, { error: bodyError.message });
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    if (pathname === '/hooks/recall' && req.method === 'POST') return recallWebhook(req, res, raw);
    if (pathname === '/hooks/demo' && req.method === 'POST') return demoReceiver(req, res, raw);
    if (pathname === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write('retry: 2000\n\n'); clients.add(res);
      return req.on('close', () => clients.delete(res));
    }
    if (pathname === '/api/health') return json(res, 200, { ok: true, mode: LIVE ? 'live' : 'simulated', region: REGION, webhook_configured: Boolean(WHSEC) });
    if (pathname === '/api/stats') return json(res, 200, stats());
    if (pathname === '/api/bots' && req.method === 'GET') return json(res, 200, [...bots.values()].sort((a, b) => b.created - a.created).map(pub));
    if (pathname === '/api/bots' && req.method === 'POST') {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { return json(res, 400, { error: 'request body must be JSON' }); }
      if (!body.meeting_url || typeof body.meeting_url !== 'string') return json(res, 400, { error: 'meeting_url is required' });
      let urlObject;
      try { urlObject = new URL(body.meeting_url); } catch { return json(res, 400, { error: 'meeting_url must be a valid URL' }); }
      if (!/^https?:$/.test(urlObject.protocol)) return json(res, 400, { error: 'meeting_url must use http or https' });
      const scenario = ['normal', 'waiting_room', 'denied', 'bad_link'].includes(body.scenario) ? body.scenario : 'normal';
      const bot = newBot(body.meeting_url, body.bot_name, scenario, typeof body.metadata === 'object' && body.metadata ? body.metadata : {});
      emit('bot', pub(bot));
      if (LIVE) createLiveBot(bot); else runDemo(bot);
      return json(res, 201, pub(bot));
    }
    const botMatch = pathname.match(/^\/api\/bots\/([\w-]+)$/);
    if (botMatch) {
      const bot = bots.get(botMatch[1]);
      return bot ? json(res, 200, { ...pub(bot), transcript: bot.transcript, diagnosis: DIAG[bot.sub] || (bot.status === 'fatal' ? { cause: `Recall reported ${bot.sub || 'an unknown fatal error'}.`, fix: 'Inspect the raw event and Recall sub-code documentation, then choose the provider-specific fix.', severity: 'unknown' } : null) }) : json(res, 404, { error: 'not found' });
    }
    if (pathname === '/api/deliveries' && req.method === 'GET') return json(res, 200, deliveries);
    const replayMatch = pathname.match(/^\/api\/deliveries\/([\w-]+)\/replay$/);
    if (replayMatch && req.method === 'POST') {
      const delivery = deliveries.find(item => item.id === replayMatch[1]);
      if (!delivery || delivery.live) return json(res, 404, { error: 'simulated delivery not found' });
      delivery.replayed = true; delivery.attempts = []; delivery.state = 'pending'; deliverDemo(delivery);
      return json(res, 202, { ok: true });
    }
    if (pathname === '/api/receiver' && req.method === 'POST') {
      try { const value = JSON.parse(raw).mode; if (['healthy', 'flaky', 'down'].includes(value)) mode = value; } catch { return json(res, 400, { error: 'mode must be JSON' }); }
      emit('stats', stats()); return json(res, 200, { mode });
    }
    if (req.method === 'GET') {
      const file = path.join(__dirname, 'public', pathname === '/' ? 'index.html' : pathname);
      if (file.startsWith(path.join(__dirname, 'public')) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, { 'content-type': pathname.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8' });
        return res.end(fs.readFileSync(file));
      }
    }
    return json(res, 404, { error: 'not found' });
  });
});
server.listen(PORT, () => console.log(`Flightdeck running → http://localhost:${PORT} [${LIVE ? `LIVE · ${REGION}` : 'SIMULATED'}]`));
