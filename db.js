const Database = require('better-sqlite3');
const path = require('path');

// Ensure data directory exists
const fs = require('fs');
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'movieshare.db');
const db = new Database(dbPath);

// Enable foreign keys
db.pragma('journal_mode = WAL');

// Initialize schema
function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS codes (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      code          TEXT UNIQUE NOT NULL,
      movie_path    TEXT NOT NULL,
      movie_name    TEXT NOT NULL,
      duration_sec  INTEGER NOT NULL,
      used          INTEGER DEFAULT 0,
      created_at    INTEGER NOT NULL,
      redeemed_at   INTEGER
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      token         TEXT UNIQUE NOT NULL,
      movie_path    TEXT NOT NULL,
      expires_at    INTEGER NOT NULL,
      created_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ip_bans (
      ip            TEXT PRIMARY KEY,
      failed_attempts INTEGER DEFAULT 0,
      banned_until  INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_codes_code ON codes(code);
    CREATE INDEX IF NOT EXISTS idx_codes_used ON codes(used);
    CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_ip_bans_ip ON ip_bans(ip);
  `);
}

initSchema();

// Code operations
const codeOps = {
  createCode(code, moviePath, movieName, durationSec) {
    const stmt = db.prepare(`
      INSERT INTO codes (code, movie_path, movie_name, duration_sec, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    return stmt.run(code, moviePath, movieName, durationSec, Math.floor(Date.now() / 1000));
  },

  getCodeByCode(code) {
    const stmt = db.prepare('SELECT * FROM codes WHERE code = ?');
    return stmt.get(code);
  },

  markCodeUsed(codeId) {
    const stmt = db.prepare(`
      UPDATE codes SET used = 1, redeemed_at = ? WHERE id = ?
    `);
    stmt.run(Math.floor(Date.now() / 1000), codeId);
  },

  getAllCodes() {
    const stmt = db.prepare('SELECT id, code, movie_path, movie_name, used, created_at, redeemed_at FROM codes ORDER BY created_at DESC');
    return stmt.all();
  },

  deleteCode(codeId) {
    const stmt = db.prepare('DELETE FROM codes WHERE id = ?');
    stmt.run(codeId);
  }
};

// Session operations
const sessionOps = {
  createSession(token, moviePath, expiresAt) {
    const stmt = db.prepare(`
      INSERT INTO sessions (token, movie_path, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `);
    return stmt.run(token, moviePath, expiresAt, Math.floor(Date.now() / 1000));
  },

  getSessionByToken(token) {
    const stmt = db.prepare('SELECT * FROM sessions WHERE token = ?');
    return stmt.get(token);
  },

  deleteExpiredSessions() {
    const now = Math.floor(Date.now() / 1000);
    const stmt = db.prepare('DELETE FROM sessions WHERE expires_at < ?');
    stmt.run(now);
  },

  deleteSessionsByMoviePath(moviePath) {
    const stmt = db.prepare('DELETE FROM sessions WHERE movie_path = ?');
    stmt.run(moviePath);
  },

  getAllSessions() {
    const stmt = db.prepare('SELECT * FROM sessions');
    return stmt.all();
  }
};

// IP ban operations
const banOps = {
  getIpBan(ip) {
    const stmt = db.prepare('SELECT * FROM ip_bans WHERE ip = ?');
    return stmt.get(ip);
  },

  incrementFailedAttempts(ip) {
    const existing = this.getIpBan(ip);
    if (existing) {
      const stmt = db.prepare('UPDATE ip_bans SET failed_attempts = failed_attempts + 1 WHERE ip = ?');
      stmt.run(ip);
      return existing.failed_attempts + 1;
    } else {
      const stmt = db.prepare('INSERT INTO ip_bans (ip, failed_attempts) VALUES (?, 1)');
      stmt.run(ip);
      return 1;
    }
  },

  setBanUntil(ip, banUntil) {
    const stmt = db.prepare('UPDATE ip_bans SET banned_until = ? WHERE ip = ?');
    stmt.run(banUntil, ip);
  },

  isBanned(ip) {
    const ban = this.getIpBan(ip);
    if (!ban) return false;
    if (!ban.banned_until) return false;
    const now = Math.floor(Date.now() / 1000);
    return ban.banned_until > now;
  },

  getAllBans() {
    const stmt = db.prepare('SELECT ip, failed_attempts, banned_until FROM ip_bans ORDER BY failed_attempts DESC');
    return stmt.all();
  },

  unbanIp(ip) {
    const stmt = db.prepare('DELETE FROM ip_bans WHERE ip = ?');
    stmt.run(ip);
  }
};

module.exports = {
  db,
  codes: codeOps,
  sessions: sessionOps,
  bans: banOps
};
