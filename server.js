'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_SCORES = 999;
const DATA_FILE = process.env.DB_PATH || path.join(__dirname, 'leaderboard.json');
const BENCH_FILE = process.env.BENCH_PATH || path.join(path.dirname(DATA_FILE), 'benchmarks.json');
const FEEDBACK_FILE = process.env.FEEDBACK_PATH || path.join(path.dirname(DATA_FILE), 'feedback.json');
const META_FILE = process.env.META_PATH || path.join(path.dirname(DATA_FILE), 'meta.json');
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const OWNER_EMAIL = process.env.OWNER_EMAIL || '';
const FROM_EMAIL = process.env.FROM_EMAIL || 'onboarding@resend.dev';
const LEVELS = ['easy', 'medium', 'hard', 'extreme'];
const CLEAR_PIN = process.env.CLEAR_PIN || '160417';
const MAX_THREAD = 200;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data)); }
  catch (e) { console.error('Failed to write ' + file + ':', e.message); }
}

let scores = Array.isArray(readJson(DATA_FILE, [])) ? readJson(DATA_FILE, []) : [];
let nextId = scores.reduce((max, r) => Math.max(max, r.id || 0), 0) + 1;

let benchmarks = readJson(BENCH_FILE, {});
if (!benchmarks || typeof benchmarks !== 'object' || Array.isArray(benchmarks)) benchmarks = {};

// Conversations: { key: { name, messages: [{from,text,at}], userUnread, updatedAt } }
let convos = {};
(function initConvos() {
  const raw = readJson(FEEDBACK_FILE, {});
  if (Array.isArray(raw)) {
    for (const f of raw) {
      const name = (f && f.name && String(f.name).trim()) || 'Anonymous';
      const key = name.toLowerCase();
      if (!convos[key]) convos[key] = { name, messages: [], userUnread: 0, updatedAt: f.at || '' };
      convos[key].messages.push({ from: 'user', text: f.message || '', at: f.at || new Date().toISOString() });
    }
  } else if (raw && typeof raw === 'object') {
    convos = raw;
  }
})();
function saveConvos() { writeJson(FEEDBACK_FILE, convos); }

let meta = readJson(META_FILE, {});
if (!meta || typeof meta !== 'object' || Array.isArray(meta)) meta = {};
if (!meta.ownerViewedAt) meta.ownerViewedAt = '1970-01-01T00:00:00.000Z';
function saveMeta() { writeJson(META_FILE, meta); }

function ownerUnreadCount() {
  const since = String(meta.ownerViewedAt || '');
  let n = 0;
  for (const k in convos) {
    for (const m of convos[k].messages) {
      if (m.from === 'user' && String(m.at) > since) n++;
    }
  }
  return n;
}

async function sendOwnerEmail(name, message) {
  if (!RESEND_API_KEY || !OWNER_EMAIL) return; // email not configured -> skip silently
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: OWNER_EMAIL,
        subject: 'New feedback on Speed Typing Challenge',
        text: 'From: ' + name + '\n\n' + message
      })
    });
  } catch (e) { console.error('Email send failed:', e.message); }
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

function bestPerPlayer(limit) {
  const byName = {};
  for (const r of scores) {
    const key = (r.player_name || 'Anon').toLowerCase();
    const cur = byName[key];
    if (!cur || r.accuracy > cur.accuracy || (r.accuracy === cur.accuracy && r.wpm > cur.wpm)) {
      byName[key] = r;
    }
  }
  return Object.values(byName)
    .sort((a, b) => b.accuracy - a.accuracy || b.wpm - a.wpm || String(a.created_at).localeCompare(String(b.created_at)))
    .slice(0, limit);
}

function bestScoreForName(name) {
  const key = String(name || '').toLowerCase();
  let best = -1;
  for (const r of scores) {
    if ((r.player_name || '').toLowerCase() === key) {
      const s = r.accuracy * 1000 + r.wpm;
      if (s > best) best = s;
    }
  }
  return best;
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/scores', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 100);
  res.json(bestPerPlayer(limit));
});

app.post('/api/scores', (req, res) => {
  if (scores.length >= MAX_SCORES) return res.status(409).json({ error: `Leaderboard full (${MAX_SCORES} max).` });
  const { errors, value } = validateScore(req.body);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });
  const row = { id: nextId++, player_name: value.player_name, wpm: value.wpm, accuracy: value.accuracy, difficulty: value.difficulty, created_at: new Date().toISOString() };
  scores.push(row);
  writeJson(DATA_FILE, scores);
  res.status(201).json(row);
});

app.delete('/api/scores', (req, res) => {
  const pin = String((req.query && req.query.pin) || (req.body && req.body.pin) || '');
  if (pin !== CLEAR_PIN) return res.status(403).json({ error: 'Incorrect PIN.' });
  const deleted = scores.length;
  scores = [];
  writeJson(DATA_FILE, scores);
  res.json({ deleted });
});

app.get('/api/benchmark', (req, res) => {
  const key = String((req.query && req.query.player) || '').trim().toLowerCase();
  if (!key) return res.status(400).json({ error: 'player is required' });
  res.json(benchmarks[key] || null);
});
app.post('/api/benchmark', (req, res) => {
  const b = req.body || {};
  const player_name = typeof b.player_name === 'string' ? b.player_name.trim() : '';
  if (!player_name) return res.status(400).json({ error: 'player_name is required' });
  const wpm = Number(b.wpm);
  if (!Number.isFinite(wpm) || wpm < 0 || wpm > 400) return res.status(400).json({ error: 'wpm must be between 0 and 400' });
  const accuracy = Number(b.accuracy);
  if (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 100) return res.status(400).json({ error: 'accuracy must be between 0 and 100' });
  const key = player_name.toLowerCase();
  const previous = benchmarks[key] || null;
  const current = { player_name, wpm: Math.round(wpm), accuracy: Math.round(accuracy), at: new Date().toISOString() };
  benchmarks[key] = current;
  writeJson(BENCH_FILE, benchmarks);
  res.json({ previous, current });
});

// ---- Feedback + messaging ----

app.post('/api/feedback', (req, res) => {
  const b = req.body || {};
  const message = typeof b.message === 'string' ? b.message.trim() : '';
  let name = typeof b.name === 'string' ? b.name.trim().slice(0, 40) : '';
  if (!name) name = 'Anonymous';
  if (!message) return res.status(400).json({ error: 'message is required' });
  if (message.length > 1000) return res.status(400).json({ error: 'message too long (1000 characters max)' });
  const key = name.toLowerCase();
  let c = convos[key] || (convos[key] = { name, messages: [], userUnread: 0, updatedAt: '' });
  c.name = name;
  c.messages.push({ from: 'user', text: message, at: new Date().toISOString() });
  if (c.messages.length > MAX_THREAD) c.messages = c.messages.slice(-MAX_THREAD);
  c.updatedAt = new Date().toISOString();
  saveConvos();
  sendOwnerEmail(name, message); // fire-and-forget; no-op if email not configured
  res.status(201).json({ ok: true });
});

app.get('/api/messages', (req, res) => {
  const name = String((req.query && req.query.player) || '').trim();
  if (!name) return res.status(400).json({ error: 'player is required' });
  const c = convos[name.toLowerCase()];
  if (!c) return res.json({ name, messages: [], userUnread: 0 });
  c.userUnread = 0;
  saveConvos();
  res.json({ name: c.name, messages: c.messages, userUnread: 0 });
});

app.get('/api/messages/unread', (req, res) => {
  const name = String((req.query && req.query.player) || '').trim();
  if (!name) return res.json({ unread: 0 });
  const c = convos[name.toLowerCase()];
  res.json({ unread: c ? (c.userUnread || 0) : 0 });
});

app.post('/api/messages/owner', (req, res) => {
  const b = req.body || {};
  if (String(b.pin || '') !== CLEAR_PIN) return res.status(403).json({ error: 'Incorrect PIN.' });
  const name = typeof b.player === 'string' ? b.player.trim() : '';
  const text = typeof b.text === 'string' ? b.text.trim() : '';
  if (!name) return res.status(400).json({ error: 'player is required' });
  if (!text) return res.status(400).json({ error: 'text is required' });
  if (text.length > 1000) return res.status(400).json({ error: 'text too long (1000 characters max)' });
  const key = name.toLowerCase();
  let c = convos[key] || (convos[key] = { name, messages: [], userUnread: 0, updatedAt: '' });
  c.messages.push({ from: 'owner', text, at: new Date().toISOString() });
  if (c.messages.length > MAX_THREAD) c.messages = c.messages.slice(-MAX_THREAD);
  c.userUnread = (c.userUnread || 0) + 1;
  c.updatedAt = new Date().toISOString();
  saveConvos();
  res.json({ ok: true });
});

app.get('/api/feedback', (req, res) => {
  if (String((req.query && req.query.pin) || '') !== CLEAR_PIN) return res.status(403).json({ error: 'Incorrect PIN.' });
  meta.ownerViewedAt = new Date().toISOString();
  saveMeta();
  const arr = Object.values(convos).map(c => ({ name: c.name, messages: c.messages, userUnread: c.userUnread || 0 }));
  arr.sort((a, b) => bestScoreForName(b.name) - bestScoreForName(a.name) || String(a.name).localeCompare(String(b.name)));
  res.json(arr);
});

app.get('/api/feedback/unread', (req, res) => {
  if (String((req.query && req.query.pin) || '') !== CLEAR_PIN) return res.status(403).json({ error: 'Incorrect PIN.' });
  res.json({ unread: ownerUnreadCount() });
});

app.delete('/api/feedback', (req, res) => {
  if (String((req.query && req.query.pin) || (req.body && req.body.pin) || '') !== CLEAR_PIN) return res.status(403).json({ error: 'Incorrect PIN.' });
  convos = {};
  saveConvos();
  res.json({ ok: true });
});

// Resolve a typed name to a known full name (first-name-only lookup)
function knownNames() {
  const set = {};
  for (const r of scores) { const n = (r.player_name || '').trim(); if (n) set[n.toLowerCase()] = n; }
  for (const k in convos) { const n = (convos[k].name || '').trim(); if (n) set[n.toLowerCase()] = n; }
  for (const k in benchmarks) { const n = (benchmarks[k].player_name || '').trim(); if (n) set[n.toLowerCase()] = n; }
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

app.listen(PORT, () => {
  console.log(`Speed Typing Challenge running on http://localhost:${PORT}`);
});
