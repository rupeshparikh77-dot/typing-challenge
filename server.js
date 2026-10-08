'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_SCORES = 5000;

const DATA_FILE = process.env.DB_PATH || path.join(__dirname, 'leaderboard.json');
const DIR = path.dirname(DATA_FILE);
const BENCH_FILE = process.env.BENCH_PATH || path.join(DIR, 'benchmarks.json');
const CHAT_FILE = process.env.CHAT_PATH || path.join(DIR, 'chat.json');
const EMAIL_FILE = process.env.EMAIL_PATH || path.join(DIR, 'emails.json');
const BATTLE_FILE = process.env.BATTLE_PATH || path.join(DIR, 'battles.json');
const META_FILE = process.env.META_PATH || path.join(DIR, 'meta.json');

const LEVELS = ['easy', 'medium', 'hard', 'extreme'];
const CLEAR_PIN = process.env.CLEAR_PIN || '160417';
const OWNER_NAME = process.env.OWNER_NAME || 'Rishi Parikh';
const OWNER_EMAIL = process.env.OWNER_EMAIL || 'rupeshparikh77@gmail.com';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const FROM_EMAIL = process.env.FROM_EMAIL || 'onboarding@resend.dev';
const SITE_URL = process.env.SITE_URL || 'https://speed-typing-challenge.onrender.com';
const MAX_THREAD = 300;

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data)); }
  catch (e) { console.error('Failed to write ' + file + ':', e.message); }
}
function keyOf(name) { return String(name || '').trim().toLowerCase(); }

let scores = readJson(DATA_FILE, []);
if (!Array.isArray(scores)) scores = [];
let nextId = scores.reduce((m, r) => Math.max(m, r.id || 0), 0) + 1;

let benchmarks = readJson(BENCH_FILE, {});
if (!benchmarks || typeof benchmarks !== 'object' || Array.isArray(benchmarks)) benchmarks = {};

// chats: { key: { name, messages:[{from:'user'|'owner', text, at}], userUnread } }
let chats = readJson(CHAT_FILE, {});
if (!chats || typeof chats !== 'object' || Array.isArray(chats)) chats = {};

// emails: { key: { name, email } }
let emails = readJson(EMAIL_FILE, {});
if (!emails || typeof emails !== 'object' || Array.isArray(emails)) emails = {};

// battles: { id: { id, from, to, time, results:{key:{name,totalAcc,totalWpm,at}}, winner, status, createdAt } }
let battles = readJson(BATTLE_FILE, {});
if (!battles || typeof battles !== 'object' || Array.isArray(battles)) battles = {};
let nextBattleId = Object.keys(battles).reduce((m, id) => Math.max(m, parseInt(id, 10) || 0), 0) + 1;

let meta = readJson(META_FILE, {});
if (!meta || typeof meta !== 'object' || Array.isArray(meta)) meta = {};
if (!meta.ownerViewedAt) meta.ownerViewedAt = '1970-01-01T00:00:00.000Z';

function saveScores() { writeJson(DATA_FILE, scores); }
function saveBench() { writeJson(BENCH_FILE, benchmarks); }
function saveChats() { writeJson(CHAT_FILE, chats); }
function saveEmails() { writeJson(EMAIL_FILE, emails); }
function saveBattles() { writeJson(BATTLE_FILE, battles); }
function saveMeta() { writeJson(META_FILE, meta); }

// ---------------------------------------------------------------------------
// Email (Resend) - silent no-op if not configured
// ---------------------------------------------------------------------------
async function sendEmail(to, subject, text) {
  if (!RESEND_API_KEY) return { ok: false, skipped: true, reason: 'RESEND_API_KEY is not set in the environment' };
  if (!to) return { ok: false, skipped: true, reason: 'no recipient email' };
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM_EMAIL, to: to, subject: subject, text: text })
    });
    let body = '';
    try { body = await r.text(); } catch (e) {}
    if (!r.ok) console.error('Resend error', r.status, body);
    return { ok: r.ok, status: r.status, body: body };
  } catch (e) {
    console.error('Email send failed:', e.message);
    return { ok: false, error: e.message };
  }
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Validation + helpers
// ---------------------------------------------------------------------------
function validateScore(body = {}) {
  const errors = [];
  const player_name = typeof body.player_name === 'string' ? body.player_name.trim() : '';
  if (!player_name) errors.push('player_name is required');
  if (player_name.length > 40) errors.push('player_name must be 40 characters or fewer');
  const wpm = Number(body.wpm);
  if (!Number.isFinite(wpm) || wpm < 0 || wpm > 400) errors.push('wpm must be a number between 0 and 400');
  const accuracy = Number(body.accuracy);
  if (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 100) errors.push('accuracy must be a number between 0 and 100');
  let difficulty = typeof body.difficulty === 'string' ? body.difficulty.trim().toLowerCase() : '';
  if (!LEVELS.includes(difficulty)) difficulty = '';
  return { errors, value: { player_name, wpm: Math.round(wpm), accuracy: Math.round(accuracy), difficulty } };
}

function isEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim()) && s.length <= 120;
}

// One entry per player: their best try + how many tries + whether they have an email
function playerSummaries() {
  const byKey = {};
  for (const r of scores) {
    const k = keyOf(r.player_name || 'Anon');
    if (!byKey[k]) byKey[k] = { name: r.player_name || 'Anon', best: r, tries: 0 };
    byKey[k].tries++;
    const cur = byKey[k].best;
    if (r.accuracy > cur.accuracy || (r.accuracy === cur.accuracy && r.wpm > cur.wpm)) byKey[k].best = r;
  }
  return Object.keys(byKey).map(k => ({
    name: byKey[k].name,
    wpm: byKey[k].best.wpm,
    accuracy: byKey[k].best.accuracy,
    tries: byKey[k].tries,
    hasEmail: !!emails[k]
  })).sort((a, b) => b.accuracy - a.accuracy || b.wpm - a.wpm || a.name.localeCompare(b.name));
}

function bestScoreForName(name) {
  const k = keyOf(name);
  let best = -1;
  for (const r of scores) {
    if (keyOf(r.player_name) === k) {
      const s = r.accuracy * 1000 + r.wpm;
      if (s > best) best = s;
    }
  }
  return best;
}

function ownerUnreadCount() {
  const since = String(meta.ownerViewedAt || '');
  let n = 0;
  for (const k in chats) for (const m of chats[k].messages) if (m.from === 'user' && String(m.at) > since) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
app.get('/api/health', (req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------------------
// Leaderboard: players (grouped) + per-player tries
// ---------------------------------------------------------------------------
app.get('/api/players', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  res.json(playerSummaries().slice(0, limit));
});

// All tries for one player (newest first)
app.get('/api/scores', (req, res) => {
  const player = (req.query && req.query.player) ? keyOf(req.query.player) : '';
  if (player) {
    const list = scores.filter(r => keyOf(r.player_name) === player)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .map(r => ({ wpm: r.wpm, accuracy: r.accuracy, difficulty: r.difficulty, created_at: r.created_at }));
    return res.json(list);
  }
  // No player given -> player summaries (keeps old callers working)
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  res.json(playerSummaries().slice(0, limit));
});

app.post('/api/scores', (req, res) => {
  if (scores.length >= MAX_SCORES) return res.status(409).json({ error: 'Leaderboard storage is full.' });
  const { errors, value } = validateScore(req.body);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });
  const row = { id: nextId++, player_name: value.player_name, wpm: value.wpm, accuracy: value.accuracy, difficulty: value.difficulty, created_at: new Date().toISOString() };
  scores.push(row);
  saveScores();
  res.status(201).json(row);
});

app.delete('/api/scores', (req, res) => {
  const pin = String((req.query && req.query.pin) || (req.body && req.body.pin) || '');
  if (pin !== CLEAR_PIN) return res.status(403).json({ error: 'Incorrect PIN.' });
  const deleted = scores.length;
  scores = [];
  saveScores();
  res.json({ deleted });
});

// ---------------------------------------------------------------------------
// Progress test (per-player benchmark)
// ---------------------------------------------------------------------------
app.get('/api/benchmark', (req, res) => {
  const k = keyOf((req.query && req.query.player) || '');
  if (!k) return res.status(400).json({ error: 'player is required' });
  res.json(benchmarks[k] || null);
});
app.post('/api/benchmark', (req, res) => {
  const b = req.body || {};
  const player_name = typeof b.player_name === 'string' ? b.player_name.trim() : '';
  if (!player_name) return res.status(400).json({ error: 'player_name is required' });
  const wpm = Number(b.wpm);
  if (!Number.isFinite(wpm) || wpm < 0 || wpm > 400) return res.status(400).json({ error: 'wpm must be between 0 and 400' });
  const accuracy = Number(b.accuracy);
  if (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 100) return res.status(400).json({ error: 'accuracy must be between 0 and 100' });
  const k = keyOf(player_name);
  const previous = benchmarks[k] || null;
  const current = { player_name, wpm: Math.round(wpm), accuracy: Math.round(accuracy), at: new Date().toISOString() };
  benchmarks[k] = current;
  saveBench();
  res.json({ previous, current });
});

// ---------------------------------------------------------------------------
// Name resolution (first-name-only login still finds the full name)
// ---------------------------------------------------------------------------
function knownNames() {
  const set = {};
  for (const r of scores) { const n = (r.player_name || '').trim(); if (n) set[n.toLowerCase()] = n; }
  for (const k in chats) { const n = (chats[k].name || '').trim(); if (n) set[n.toLowerCase()] = n; }
  for (const k in benchmarks) { const n = (benchmarks[k].player_name || '').trim(); if (n) set[n.toLowerCase()] = n; }
  for (const k in emails) { const n = (emails[k].name || '').trim(); if (n) set[n.toLowerCase()] = n; }
  return Object.values(set);
}
app.get('/api/resolve-name', (req, res) => {
  const typed = String((req.query && req.query.name) || '').trim();
  if (!typed) return res.json({ name: '', ambiguous: false, options: [] });
  const lower = typed.toLowerCase();
  const names = knownNames();
  const exact = names.find(n => n.toLowerCase() === lower);
  if (exact) return res.json({ name: exact, ambiguous: false, options: [] });
  if (!typed.includes(' ')) {
    const matches = names.filter(n => n.split(/\s+/)[0].toLowerCase() === lower);
    if (matches.length === 1) return res.json({ name: matches[0], ambiguous: false, options: [] });
    if (matches.length > 1) return res.json({ name: typed, ambiguous: true, options: matches });
  }
  return res.json({ name: typed, ambiguous: false, options: [] });
});

// ---------------------------------------------------------------------------
// Email capture
// ---------------------------------------------------------------------------
app.get('/api/email', (req, res) => {
  const k = keyOf((req.query && req.query.player) || '');
  const rec = emails[k];
  res.json({ hasEmail: !!rec, email: rec ? rec.email : '' });
});
app.post('/api/email', (req, res) => {
  const b = req.body || {};
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  const email = typeof b.email === 'string' ? b.email.trim() : '';
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!isEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
  emails[keyOf(name)] = { name, email };
  saveEmails();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Chat (every player <-> the owner, Rishi Parikh)
// ---------------------------------------------------------------------------

// Player sends a message to the owner
app.post('/api/chat', async (req, res) => {
  const b = req.body || {};
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  const message = typeof b.message === 'string' ? b.message.trim() : '';
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!message) return res.status(400).json({ error: 'message is required' });
  if (message.length > 1000) return res.status(400).json({ error: 'message too long (1000 max)' });
  const k = keyOf(name);
  let c = chats[k] || (chats[k] = { name, messages: [], userUnread: 0 });
  c.name = name;
  c.messages.push({ from: 'user', text: message, at: new Date().toISOString() });
  if (c.messages.length > MAX_THREAD) c.messages = c.messages.slice(-MAX_THREAD);
  saveChats();
  sendEmail(OWNER_EMAIL, 'New chat message on Speed Typing Challenge', 'From: ' + name + '\n\n' + message + '\n\nOpen the game to reply: ' + SITE_URL);
  res.status(201).json({ ok: true });
});

// Player loads their own thread (marks owner replies read)
app.get('/api/chat', (req, res) => {
  const name = String((req.query && req.query.player) || '').trim();
  if (!name) return res.status(400).json({ error: 'player is required' });
  const c = chats[keyOf(name)];
  if (!c) return res.json({ name, messages: [], userUnread: 0 });
  c.userUnread = 0;
  saveChats();
  res.json({ name: c.name, messages: c.messages, userUnread: 0 });
});

// Unread replies for the "You have a new message" popup
app.get('/api/chat/unread', (req, res) => {
  const name = String((req.query && req.query.player) || '').trim();
  if (!name) return res.json({ unread: 0 });
  const c = chats[keyOf(name)];
  res.json({ unread: c ? (c.userUnread || 0) : 0 });
});

// Owner replies (PIN required). Emails the player if they have an address.
app.post('/api/chat/owner', async (req, res) => {
  const b = req.body || {};
  if (String(b.pin || '') !== CLEAR_PIN) return res.status(403).json({ error: 'Incorrect PIN.' });
  const name = typeof b.player === 'string' ? b.player.trim() : '';
  const text = typeof b.text === 'string' ? b.text.trim() : '';
  if (!name) return res.status(400).json({ error: 'player is required' });
  if (!text) return res.status(400).json({ error: 'text is required' });
  if (text.length > 1000) return res.status(400).json({ error: 'text too long (1000 max)' });
  const k = keyOf(name);
  let c = chats[k] || (chats[k] = { name, messages: [], userUnread: 0 });
  c.messages.push({ from: 'owner', text, at: new Date().toISOString() });
  if (c.messages.length > MAX_THREAD) c.messages = c.messages.slice(-MAX_THREAD);
  c.userUnread = (c.userUnread || 0) + 1;
  saveChats();
  const rec = emails[k];
  if (rec && rec.email) {
    sendEmail(rec.email, 'You have a new message on Speed Typing Challenge',
      'The owner replied to your message. Visit the game to read it and reply:\n' + SITE_URL +
      '\n\nWarm regards, Speed Typing Challenge Online Game By Rishi');
  }
  res.json({ ok: true });
});

// Owner views all threads (PIN). Grouped by player, ordered by their best score.
app.get('/api/chat/all', (req, res) => {
  if (String((req.query && req.query.pin) || '') !== CLEAR_PIN) return res.status(403).json({ error: 'Incorrect PIN.' });
  meta.ownerViewedAt = new Date().toISOString();
  saveMeta();
  const arr = Object.values(chats).map(c => ({ name: c.name, messages: c.messages, userUnread: c.userUnread || 0 }));
  arr.sort((a, b) => bestScoreForName(b.name) - bestScoreForName(a.name) || String(a.name).localeCompare(String(b.name)));
  res.json(arr);
});

// Owner unread badge (PIN)
app.get('/api/chat/owner-unread', (req, res) => {
  if (String((req.query && req.query.pin) || '') !== CLEAR_PIN) return res.status(403).json({ error: 'Incorrect PIN.' });
  res.json({ unread: ownerUnreadCount() });
});

app.delete('/api/chat', (req, res) => {
  if (String((req.query && req.query.pin) || (req.body && req.body.pin) || '') !== CLEAR_PIN) return res.status(403).json({ error: 'Incorrect PIN.' });
  chats = {};
  saveChats();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Friend battles (async)
// ---------------------------------------------------------------------------
function battleView(bt, forName) {
  const fromKey = keyOf(bt.from), toKey = keyOf(bt.to), youKey = keyOf(forName);
  const youName = youKey === fromKey ? bt.from : (youKey === toKey ? bt.to : forName);
  const oppName = youKey === fromKey ? bt.to : bt.from;
  const yours = bt.results[youKey] || null;
  const opp = bt.results[keyOf(oppName)] || null;
  const bothDone = !!(bt.results[fromKey] && bt.results[toKey]);
  return {
    id: bt.id, from: bt.from, to: bt.to, time: bt.time,
    you: youName, opponent: oppName,
    yourResult: yours, opponentResult: opp,
    bothDone, winner: bothDone ? bt.winner : null, status: bt.status
  };
}

// Create a challenge. The opponent MUST have an email on file.
app.post('/api/battle', async (req, res) => {
  const b = req.body || {};
  const from = typeof b.from === 'string' ? b.from.trim() : '';
  const to = typeof b.to === 'string' ? b.to.trim() : '';
  const time = typeof b.time === 'string' ? b.time.trim().slice(0, 40) : '';
  if (!from || !to) return res.status(400).json({ error: 'from and to are required' });
  if (keyOf(from) === keyOf(to)) return res.status(400).json({ error: 'You cannot battle yourself.' });
  const rec = emails[keyOf(to)];
  if (!rec || !rec.email) {
    return res.status(400).json({ error: "You can't friend this person because they have not entered their email." });
  }
  const id = String(nextBattleId++);
  const bt = { id, from, to, time, results: {}, winner: null, status: 'open', createdAt: new Date().toISOString() };
  battles[id] = bt;
  saveBattles();
  const body =
    'New friend request on speed typing challenge!\n' +
    from + ' friended you and please go to the web at ' + (time || '(any time)') + ' to battle!\n' +
    'here is the link: ' + SITE_URL + '\n\n' +
    'Warm regards, Speed Typing Challenge Online Game By Rishi';
  sendEmail(rec.email, 'New friend request on Speed Typing Challenge!', body);
  res.status(201).json({ id });
});

// Battles this player still needs to play (challenged, not yet played)
app.get('/api/battle/pending', (req, res) => {
  const k = keyOf((req.query && req.query.player) || '');
  if (!k) return res.json([]);
  const list = Object.values(battles)
    .filter(bt => (keyOf(bt.from) === k || keyOf(bt.to) === k) && !bt.results[k] && bt.status !== 'done')
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map(bt => battleView(bt, (req.query && req.query.player) || ''));
  res.json(list);
});

// Submit this player's combined battle result
app.post('/api/battle/score', (req, res) => {
  const b = req.body || {};
  const id = String(b.id || '');
  const player = typeof b.player === 'string' ? b.player.trim() : '';
  const bt = battles[id];
  if (!bt) return res.status(404).json({ error: 'battle not found' });
  const k = keyOf(player);
  if (k !== keyOf(bt.from) && k !== keyOf(bt.to)) return res.status(400).json({ error: 'not a participant' });
  const totalAcc = Number(b.totalAcc), totalWpm = Number(b.totalWpm);
  if (!Number.isFinite(totalAcc) || !Number.isFinite(totalWpm)) return res.status(400).json({ error: 'invalid result' });
  bt.results[k] = { name: player, totalAcc: Math.round(totalAcc), totalWpm: Math.round(totalWpm), at: new Date().toISOString() };
  const fk = keyOf(bt.from), tk = keyOf(bt.to);
  if (bt.results[fk] && bt.results[tk]) {
    const A = bt.results[fk], B = bt.results[tk];
    if (A.totalAcc !== B.totalAcc) bt.winner = A.totalAcc > B.totalAcc ? A.name : B.name;
    else if (A.totalWpm !== B.totalWpm) bt.winner = A.totalWpm > B.totalWpm ? A.name : B.name;
    else bt.winner = 'Tie';
    bt.status = 'done';
  }
  saveBattles();
  res.json(battleView(bt, player));
});

// Poll a battle's state
app.get('/api/battle/:id', (req, res) => {
  const bt = battles[req.params.id];
  if (!bt) return res.status(404).json({ error: 'battle not found' });
  res.json(battleView(bt, (req.query && req.query.player) || ''));
});

app.delete('/api/battle', (req, res) => {
  if (String((req.query && req.query.pin) || (req.body && req.body.pin) || '') !== CLEAR_PIN) return res.status(403).json({ error: 'Incorrect PIN.' });
  battles = {};
  saveBattles();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Email diagnostics (owner only). Visit in a browser:
//   /api/email-test?pin=YOUR_PIN            -> sends a test to OWNER_EMAIL
//   /api/email-test?pin=YOUR_PIN&to=x@y.com -> sends a test to any address
// The JSON it returns tells you exactly why email is or isn't working.
// ---------------------------------------------------------------------------
app.get('/api/email-test', async (req, res) => {
  if (String((req.query && req.query.pin) || '') !== CLEAR_PIN) {
    return res.status(403).json({ error: 'Incorrect PIN.' });
  }
  const config = {
    RESEND_API_KEY_set: !!RESEND_API_KEY,
    OWNER_EMAIL: OWNER_EMAIL || '(not set)',
    FROM_EMAIL: FROM_EMAIL,
    SITE_URL: SITE_URL
  };
  const to = (req.query && req.query.to) ? String(req.query.to) : OWNER_EMAIL;
  const result = await sendEmail(to, 'Speed Typing Challenge — test email',
    'If you can read this, email sending works. This test was sent to: ' + to);
  let hint = '';
  if (!RESEND_API_KEY) hint = 'RESEND_API_KEY is missing. Add it in Render → Environment, then redeploy.';
  else if (result && result.ok) hint = 'Resend accepted the email. Check the inbox (and spam) for ' + to + '.';
  else if (result && result.status === 403) hint = 'Resend rejected it. With the shared sender onboarding@resend.dev you can ONLY email the address you signed up to Resend with. To email other players you must verify your own domain in Resend and set FROM_EMAIL to an address at that domain.';
  else if (result && result.status === 422) hint = 'Resend validation error (often: sending to an address other than your Resend signup email while using onboarding@resend.dev, or an invalid FROM_EMAIL). See body above.';
  else hint = 'See status and body above for the reason Resend returned.';
  res.json({ config, sentTo: to, result, hint });
});

app.listen(PORT, () => {
  console.log(`Speed Typing Challenge running on http://localhost:${PORT}`);
});
