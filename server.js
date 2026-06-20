'use strict';

const path = require('path');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_SCORES = 999;

// ---------------------------------------------------------------------------
// Database (real SQLite via Node's built-in driver — no native build needed)
// ---------------------------------------------------------------------------
const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, 'leaderboard.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS scores (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    player_name TEXT    NOT NULL,
    wpm         INTEGER NOT NULL,
    accuracy    INTEGER NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

const stmts = {
  list:   db.prepare(`SELECT id, player_name, wpm, accuracy, created_at
                      FROM scores
                      ORDER BY accuracy DESC, wpm DESC, created_at ASC
                      LIMIT ?`),
  count:  db.prepare(`SELECT COUNT(*) AS c FROM scores`),
  insert: db.prepare(`INSERT INTO scores (player_name, wpm, accuracy) VALUES (?, ?, ?)`),
  getOne: db.prepare(`SELECT id, player_name, wpm, accuracy, created_at FROM scores WHERE id = ?`),
  delOne: db.prepare(`DELETE FROM scores WHERE id = ?`),
  delAll: db.prepare(`DELETE FROM scores`),
};

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Validation
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

  return {
    errors,
    value: { player_name, wpm: Math.round(wpm), accuracy: Math.round(accuracy) },
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Health check
app.get('/api/health', (req, res) => res.json({ ok: true }));

// GET /api/scores?limit=10  -> sorted leaderboard
app.get('/api/scores', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 100);
  res.json(stmts.list.all(limit));
});

// POST /api/scores  -> submit a score
app.post('/api/scores', (req, res) => {
  if (stmts.count.get().c >= MAX_SCORES) {
    return res.status(409).json({ error: `Leaderboard full (${MAX_SCORES} max).` });
  }
  const { errors, value } = validateScore(req.body);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });

  const info = stmts.insert.run(value.player_name, value.wpm, value.accuracy);
  res.status(201).json(stmts.getOne.get(info.lastInsertRowid));
});

// DELETE /api/scores/:id  -> remove a single score
app.delete('/api/scores/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  const info = stmts.delOne.run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'Score not found' });
  res.json({ deleted: info.changes });
});

// DELETE /api/scores  -> clear the leaderboard
app.delete('/api/scores', (req, res) => {
  const info = stmts.delAll.run();
  res.json({ deleted: info.changes });
});

// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Speed Typing Challenge running on http://localhost:${PORT}`);
});
