'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_SCORES = 999;
const DATA_FILE = process.env.DB_PATH || path.join(__dirname, 'leaderboard.json');

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function save(rows) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(rows));
  } catch (e) {
    console.error('Failed to write data file:', e.message);
  }
}

let scores = load();
let nextId = scores.reduce((max, r) => Math.max(max, r.id || 0), 0) + 1;

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

  return {
    errors,
    value: { player_name, wpm: Math.round(wpm), accuracy: Math.round(accuracy) },
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
    created_at: new Date().toISOString(),
  };
  scores.push(row);
  save(scores);
  res.status(201).json(row);
});

app.delete('/api/scores/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  const before = scores.length;
  scores = scores.filter((r) => r.id !== id);
  if (scores.length === before) return res.status(404).json({ error: 'Score not found' });
  save(scores);
  res.json({ deleted: before - scores.length });
});

app.delete('/api/scores', (req, res) => {
  const deleted = scores.length;
  scores = [];
  save(scores);
  res.json({ deleted });
});

app.listen(PORT, () => {
  console.log(`Speed Typing Challenge running on http://localhost:${PORT}`);
});
