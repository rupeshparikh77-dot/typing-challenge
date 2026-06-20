# Speed Typing Challenge

A typing-speed game with a real REST API backing the leaderboard. The frontend
(`public/index.html`) talks to an Express server over HTTP/JSON instead of the
original Canva data SDK, so it runs anywhere and persists scores in SQLite.

## Run locally

```bash
npm install
npm start          # http://localhost:3000
```

Requires **Node.js 22.5+** (uses the built-in `node:sqlite` driver — no native
build step). The database file `leaderboard.db` is created automatically;
override its location with the `DB_PATH` env var.

## API

Base path: `/api`

| Method   | Path           | Body                                        | Description                          |
|----------|----------------|---------------------------------------------|--------------------------------------|
| `GET`    | `/health`      | —                                           | Liveness check → `{ ok: true }`      |
| `GET`    | `/scores`      | —                                           | Top scores, sorted. `?limit=1..100` (default 10) |
| `POST`   | `/scores`      | `{ player_name, wpm, accuracy }`            | Add a score → returns the saved row  |
| `DELETE` | `/scores/:id`  | —                                           | Remove one score                     |
| `DELETE` | `/scores`      | —                                           | Clear the whole leaderboard          |

Sorting: `accuracy DESC, wpm DESC, created_at ASC`.

### Validation
- `player_name` — required, trimmed, max 40 chars
- `wpm` — number, 0–400
- `accuracy` — number, 0–100
- Leaderboard caps at 999 rows (returns `409` when full)

Invalid input returns `400` with `{ "error": "..." }`.

### Examples

```bash
# Submit a score
curl -X POST http://localhost:3000/api/scores \
  -H 'Content-Type: application/json' \
  -d '{"player_name":"Rupesh","wpm":82,"accuracy":97}'

# Top 10
curl http://localhost:3000/api/scores

# Clear
curl -X DELETE http://localhost:3000/api/scores
```

## Deploy

Works on Render, Railway, Replit, Fly, etc. Build command `npm install`,
start command `npm start`. The host must provide a `PORT` env var (already
honored) and a writable disk for `leaderboard.db` — on Render attach a
persistent disk, otherwise the SQLite file resets on redeploy.

A ready-to-use Render blueprint is included in `render.yaml`.

## Note on the SQLite driver

This uses Node's built-in `node:sqlite`, which prints an
`ExperimentalWarning` on startup (harmless). To silence it or to run on
Node < 22, swap the two `require` lines in `server.js` for
[`better-sqlite3`](https://www.npmjs.com/package/better-sqlite3) — the
prepared-statement calls are nearly identical.
