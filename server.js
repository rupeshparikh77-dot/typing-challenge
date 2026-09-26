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
const LEVELS = ['easy', 'medium', 'hard', 'extreme'];
const CLEAR_PIN = process.env.CLEAR_PIN || '160417';

function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed;
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data));
  } catch (e) {
    console.error('Failed to write ' + file + ':', e.message);
  }
}

let scores = Array.isArray(readJson(DATA_FILE, [])) ? readJson(DATA_FILE, []) : [];
let nextId = scores.reduce((max, r) => Math.max(max, r.id || 0), 0) + 1;

let benchmarks = readJson(BENCH_FILE, {});
if (!benchmarks || typeof benchmarks !== 'object' || Array.isArray(benchmarks)) benchmarks = {};

let feedback = readJson(FEEDBACK_FILE, []);
if (!Array.isArray(feedback)) feedback = [];
let nextFeedbackId = feedback.reduce((m, f) => Math.max(m, f.id || 0), 0) + 1;

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

  return {
    errors,
    value: { player_name, wpm: Math.round(wpm), accuracy: Math.round(accuracy), difficulty },
  };
}

function topScores(limit) {
  return [...scores]
    .sort((a, b) =>
      b.accuracy - a.accuracy ||
      b.wpm - a.wpm ||
      String(a.created_at).localeCompare(String(b.created_at))
    )
    .slice(0, limit);
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/scores', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 100);
  res.json(topScores(limit));
});

app.post('/api/scores', (req, res) => {
  if (scores.length >= MAX_SCORES) {
    return res.status(409).json({ error: `Leaderboard full (${MAX_SCORES} max).` });
  }
  const { errors, value } = validateScore(req.body);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });

  const row = {
    id: nextId++,
    player_name: value.player_name,
    wpm: value.wpm,
    accuracy: value.accuracy,
    difficulty: value.difficulty,
    created_at: new Date().toISOString(),
  };
  scores.push(row);
  writeJson(DATA_FILE, scores);
  res.status(201).json(row);
});

app.delete('/api/scores', (req, res) => {
  const pin = String((req.query && req.query.pin) || (req.body && req.body.pin) || '');
  if (pin !== CLEAR_PIN) {
    return res.status(403).json({ error: 'Incorrect PIN.' });
  }
  const deleted = scores.length;
  scores = [];
  writeJson(DATA_FILE, scores);
  res.json({ deleted });
});

// ---- Progress test (per-player benchmark, follows the player across devices) ----

// GET the player's last progress test
app.get('/api/benchmark', (req, res) => {
  const key = String((req.query && req.query.player) || '').trim().toLowerCase();
  if (!key) return res.status(400).json({ error: 'player is required' });
  res.json(benchmarks[key] || null);
});

// POST a new progress test; returns the previous result (for comparison) and the new one
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

// ---- Feedback hub ----

// Anyone may submit feedback
app.post('/api/feedback', (req, res) => {
  const b = req.body || {};
  const message = typeof b.message === 'string' ? b.message.trim() : '';
  const name = typeof b.name === 'string' ? b.name.trim().slice(0, 40) : '';
  if (!message) return res.status(400).json({ error: 'message is required' });
  if (message.length > 1000) return res.status(400).json({ error: 'message too long (1000 characters max)' });
  if (feedback.length >= 5000) return res.status(409).json({ error: 'feedback storage is full' });
  const row = { id: nextFeedbackId++, name, message, at: new Date().toISOString() };
  feedback.push(row);
  writeJson(FEEDBACK_FILE, feedback);
  res.status(201).json({ ok: true });
});

// Owner reads all feedback (PIN required)
app.get('/api/feedback', (req, res) => {
  const pin = String((req.query && req.query.pin) || '');
  if (pin !== CLEAR_PIN) return res.status(403).json({ error: 'Incorrect PIN.' });
  res.json([...feedback].sort((a, b) => String(b.at).localeCompare(String(a.at))));
});

// Owner clears feedback (PIN required)
app.delete('/api/feedback', (req, res) => {
  const pin = String((req.query && req.query.pin) || (req.body && req.body.pin) || '');
  if (pin !== CLEAR_PIN) return res.status(403).json({ error: 'Incorrect PIN.' });
  const deleted = feedback.length;
  feedback = [];
  writeJson(FEEDBACK_FILE, feedback);
  res.json({ deleted });
});

app.listen(PORT, () => {
  console.log(`Speed Typing Challenge running on http://localhost:${PORT}`);
});
