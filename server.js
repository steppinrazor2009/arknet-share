const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const ffmpeg = require('fluent-ffmpeg');
require('dotenv').config();

const { codes, sessions, bans } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Transcoded videos directory
const transcodedDir = process.env.TRANSCODED_VIDEOS_DIR || path.join(__dirname, 'transcoded');
console.log(`📁 Transcoded videos directory: ${transcodedDir}`);
console.log(`📁 TRANSCODED_VIDEOS_DIR env var: ${process.env.TRANSCODED_VIDEOS_DIR || '(not set)'}`);
if (!fs.existsSync(transcodedDir)) {
  fs.mkdirSync(transcodedDir, { recursive: true });
  console.log(`✅ Created transcoded directory: ${transcodedDir}`);
}

// Duration cache to avoid repeated ffprobe calls
const durationCache = new Map();
async function getVideoDurationCached(filePath) {
  if (durationCache.has(filePath)) return durationCache.get(filePath);
  const duration = await getVideoDuration(filePath);
  durationCache.set(filePath, duration);
  return duration;
}

// Track remuxing operations in progress
const remuxingOperations = new Set();
// Track remux progress: { moviePath: { percent, frames, time, bitrate, eta } }
const remuxProgress = new Map();
// CSRF token store: { token: timestamp }
const csrfTokens = new Map();

// Validation
if (!process.env.ADMIN_PASSWORD_HASH || !process.env.ADMIN_JWT_SECRET) {
  console.error('❌ Missing required environment variables. Run: node setup.js');
  process.exit(1);
}

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Remove X-Powered-By header
app.disable('x-powered-by');

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' cdn.jsdelivr.net; font-src 'self' cdn.jsdelivr.net; img-src 'self' data:; media-src 'self'");
  next();
});

// Trust proxy for X-Forwarded-For
app.set('trust proxy', 1);

// Utility: Get client IP
function getClientIp(req) {
  return req.ip || req.connection.remoteAddress || '0.0.0.0';
}

// Utility: Check if IP is in private/loopback range
function isPrivateIp(ip) {
  // Handle IPv6 loopback
  if (ip === '::1' || ip === '127.0.0.1' || ip === 'localhost') return true;

  // Remove IPv6 prefix if present (e.g., "::ffff:192.168.1.1" -> "192.168.1.1")
  const cleanIp = ip.replace(/^::ffff:/, '');

  const parts = cleanIp.split('.');
  if (parts.length !== 4) return false; // Not IPv4

  const [a, b] = parts.map(Number);

  // 127.0.0.0/8
  if (a === 127) return true;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;

  return false;
}

// Middleware: Rate limiting (simple in-memory)
const rateLimits = new Map();
function rateLimit(maxRequests, windowMs) {
  return (req, res, next) => {
    const ip = getClientIp(req);
    const key = `${ip}:${req.path}`;
    const now = Date.now();

    if (!rateLimits.has(key)) {
      rateLimits.set(key, []);
    }

    const timestamps = rateLimits.get(key);
    const recentRequests = timestamps.filter(t => now - t < windowMs);

    if (recentRequests.length >= maxRequests) {
      return res.status(429).json({ error: 'Too many requests' });
    }

    recentRequests.push(now);
    rateLimits.set(key, recentRequests);
    next();
  };
}

// Middleware: Admin local-only access
function localOnly(req, res, next) {
  const ip = getClientIp(req);
  if (!isPrivateIp(ip)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  next();
}

// Utility: Generate CSRF token
function generateCsrfToken() {
  const token = crypto.randomBytes(32).toString('hex');
  csrfTokens.set(token, Date.now());
  return token;
}

// Middleware: Verify CSRF token (for POST, PUT, DELETE)
function verifyCsrfToken(req, res, next) {
  // Only check state-changing operations
  if (!['POST', 'PUT', 'DELETE'].includes(req.method)) {
    return next();
  }

  const token = req.headers['x-csrf-token'];

  if (!token || !csrfTokens.has(token)) {
    return res.status(403).json({ error: 'CSRF token invalid or expired' });
  }

  // Token is valid, remove it (one-time use)
  csrfTokens.delete(token);
  next();
}

// Middleware: Admin JWT verification
function verifyAdminJwt(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, process.env.ADMIN_JWT_SECRET);
    req.admin = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Utility: Get video duration using ffprobe
function getVideoDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        reject(err);
      } else {
        const durationSec = Math.ceil(metadata.format.duration);
        resolve(durationSec);
      }
    });
  });
}

// Utility: Get list of movie files (recursive)
function getMovieFiles() {
  const moviesDir = path.join(__dirname, 'movies');
  if (!fs.existsSync(moviesDir)) {
    fs.mkdirSync(moviesDir, { recursive: true });
    return [];
  }

  const videoExts = ['.mp4', '.mkv', '.avi', '.mov', '.webm'];
  const movies = [];

  function scanDir(dir) {
    const files = fs.readdirSync(dir);
    files.forEach(file => {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        scanDir(fullPath);
      } else if (stat.isFile()) {
        const ext = path.extname(file).toLowerCase();
        if (videoExts.includes(ext)) {
          // Store relative path from /app/movies
          const relativePath = path.relative(moviesDir, fullPath);
          movies.push(relativePath);
        }
      }
    });
  }

  scanDir(moviesDir);
  return movies;
}

// Utility: Validate movie path (prevent directory traversal)
function validateMoviePath(filePath) {
  const moviesDir = path.resolve(path.join(__dirname, 'movies'));
  const resolvedPath = path.resolve(path.join(__dirname, 'movies', filePath));
  return resolvedPath.startsWith(moviesDir);
}

// Utility: Generate random code (8-char alphanumeric)
function generateCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// Utility: Generate random token (32-byte hex)
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Utility: Handle HTTP 206 range requests
function serveFileWithRangeSupport(req, res, filePath) {
  const fileSize = fs.statSync(filePath).size;

  const range = req.headers.range;

  if (range) {
    // Parse range header (e.g., "bytes=100-200" or "bytes=100-" or "bytes=-100")
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parts[0] ? parseInt(parts[0], 10) : 0;
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    // Validate range
    if (start >= fileSize || end >= fileSize || start > end) {
      res.status(416).setHeader('Content-Range', `bytes */${fileSize}`).end();
      return;
    }

    const chunkSize = end - start + 1;

    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
    res.setHeader('Content-Length', chunkSize);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', 'video/mp4');

    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    // No range request, serve full file
    res.setHeader('Content-Length', fileSize);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', 'video/mp4');

    fs.createReadStream(filePath).pipe(res);
  }
}

// ============ PUBLIC ROUTES ============

// Serve public/index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// POST /api/redeem - Validate code and create session
app.post('/api/redeem', rateLimit(10, 60000), (req, res) => {
  const { code } = req.body;

  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: 'Invalid code' });
  }

  const ip = getClientIp(req);

  // Check if IP is banned
  if (bans.isBanned(ip)) {
    const ban = bans.getIpBan(ip);
    return res.status(403).json({ error: 'IP banned. Try again later.' });
  }

  // Look up code
  const codeRecord = codes.getCodeByCode(code.toUpperCase());

  if (!codeRecord) {
    // Code not found
    const attempts = bans.incrementFailedAttempts(ip);
    if (attempts >= 2) {
      const banUntilTime = Math.floor(Date.now() / 1000) + 3600; // 1 hour
      bans.setBanUntil(ip, banUntilTime);
      return res.status(401).json({ error: 'Code not found. IP banned for 1 hour.' });
    }
    return res.status(401).json({ error: 'Code not found.', attemptsRemaining: 2 - attempts });
  }

  if (codeRecord.used) {
    // Code already used
    const attempts = bans.incrementFailedAttempts(ip);
    if (attempts >= 2) {
      const banUntilTime = Math.floor(Date.now() / 1000) + 3600; // 1 hour
      bans.setBanUntil(ip, banUntilTime);
      return res.status(401).json({ error: 'Code already used. IP banned for 1 hour.' });
    }
    return res.status(401).json({ error: 'Code already used.', attemptsRemaining: 2 - attempts });
  }

  // Success: mark code as used and create session
  codes.markCodeUsed(codeRecord.id);

  const expiresAt = Math.floor(Date.now() / 1000) + codeRecord.duration_sec * 1.5;
  const token = generateToken();

  sessions.createSession(token, codeRecord.movie_path, expiresAt);

  return res.json({
    token,
    movieName: codeRecord.movie_name,
    expiresAt,
    duration: codeRecord.duration_sec
  });
});

// GET /api/info - Get video metadata (duration, etc)
app.get('/api/info', async (req, res) => {
  try {
    const { token } = req.query;

    if (!token) {
      return res.status(400).json({ error: 'Token required' });
    }

    const session = sessions.getSessionByToken(token);

    if (!session) {
      return res.status(403).json({ error: 'Invalid token' });
    }

    const now = Math.floor(Date.now() / 1000);
    if (session.expires_at < now) {
      return res.status(403).json({ error: 'Token expired' });
    }

    // Validate movie path
    if (!validateMoviePath(session.movie_path)) {
      return res.status(403).json({ error: 'Invalid movie path' });
    }

    const filePath = path.join(__dirname, 'movies', session.movie_path);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Movie not found' });
    }

    // Get duration
    let duration;
    try {
      duration = await getVideoDurationCached(filePath);
    } catch (err) {
      console.error('Error getting duration:', err);
      return res.status(500).json({ error: 'Could not determine video duration' });
    }

    return res.json({ duration });
  } catch (err) {
    console.error('Info endpoint error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// GET /api/stream - Stream pre-remuxed video with token validation and range support
app.get('/api/stream', async (req, res) => {
  try {
    const { token } = req.query;

    if (!token) {
      return res.status(400).json({ error: 'Token required' });
    }

    const session = sessions.getSessionByToken(token);

    if (!session) {
      return res.status(403).json({ error: 'Invalid token' });
    }

    // Server-side expiration check
    const now = Math.floor(Date.now() / 1000);
    if (session.expires_at < now) {
      // Delete expired session
      sessions.deleteExpiredSessions();
      return res.status(403).json({ error: 'Token expired' });
    }

    // Validate movie path
    if (!validateMoviePath(session.movie_path)) {
      return res.status(403).json({ error: 'Invalid movie path' });
    }

    // Convert original movie path to transcoded mp4 path
    // e.g., "subfolder/movie.mkv" -> "subfolder/movie.mp4"
    const movieDir = path.dirname(session.movie_path);
    const movieBasename = path.basename(session.movie_path, path.extname(session.movie_path));
    const transcodedRelativePath = path.join(movieDir === '.' ? '' : movieDir, `${movieBasename}.mp4`);
    const transcodedFilePath = path.join(transcodedDir, transcodedRelativePath);

    if (!fs.existsSync(transcodedFilePath)) {
      return res.status(404).json({ error: 'Video not yet transcoded. Please contact admin.' });
    }

    // Serve with range request support for seeking
    serveFileWithRangeSupport(req, res, transcodedFilePath);
  } catch (err) {
    console.error('Stream endpoint error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});


// ============ ADMIN ROUTES ============

// GET /admin - Serve admin page (local only)
app.get('/admin', localOnly, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// GET /admin/api/csrf-token - Generate CSRF token (local only)
app.get('/admin/api/csrf-token', localOnly, (req, res) => {
  const token = generateCsrfToken();
  res.json({ csrfToken: token });
});

// POST /admin/login - Authenticate and get JWT (local only)
app.post('/admin/login', localOnly, (req, res) => {
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ error: 'Password required' });
  }

  // Check password against hash
  const isValid = bcrypt.compareSync(password, process.env.ADMIN_PASSWORD_HASH);

  if (!isValid) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  // Generate JWT (expires in 8 hours)
  const token = jwt.sign({ admin: true }, process.env.ADMIN_JWT_SECRET, { expiresIn: '8h' });

  return res.json({ token });
});

// GET /admin/api/movies - List available movies (local only, JWT required)
app.get('/admin/api/movies', localOnly, verifyAdminJwt, (req, res) => {
  const movies = getMovieFiles();
  res.json({ movies });
});

// POST /admin/api/codes - Create a new code (local only, JWT required, CSRF protected)
app.post('/admin/api/codes', localOnly, verifyCsrfToken, verifyAdminJwt, async (req, res) => {
  const { moviePath, code } = req.body;

  if (!moviePath || typeof moviePath !== 'string') {
    return res.status(400).json({ error: 'Movie path required' });
  }

  // Validate movie path
  if (!validateMoviePath(moviePath)) {
    return res.status(400).json({ error: 'Invalid movie path' });
  }

  const filePath = path.join(__dirname, 'movies', moviePath);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Movie file not found' });
  }

  // Get video duration
  let durationSec;
  try {
    durationSec = await getVideoDuration(filePath);
  } catch (err) {
    console.error('Error getting video duration:', err);
    return res.status(500).json({ error: 'Could not determine video duration' });
  }

  // Generate code or use provided
  let finalCode = code ? code.toUpperCase() : generateCode();

  // Ensure code is unique
  let attempts = 0;
  while (codes.getCodeByCode(finalCode) && attempts < 10) {
    finalCode = generateCode();
    attempts++;
  }

  if (codes.getCodeByCode(finalCode)) {
    return res.status(500).json({ error: 'Failed to generate unique code' });
  }

  // Get movie name from path
  const movieName = path.basename(moviePath);

  // Create code
  codes.createCode(finalCode, moviePath, movieName, durationSec);

  // Check if movie needs remuxing and start if not already done
  const transcodedRelativePath = getTranscodedPath(moviePath);
  const transcodedFilePath = path.join(transcodedDir, transcodedRelativePath);
  const isTranscoded = fs.existsSync(transcodedFilePath);
  const isRemuxing = remuxingOperations.has(moviePath);

  if (!isTranscoded && !isRemuxing) {
    // Auto-start remuxing
    remuxingOperations.add(moviePath);
    console.log(`Auto-starting remux: ${moviePath} -> ${transcodedRelativePath}`);

    // Create output directory if needed
    const outputDir = path.dirname(transcodedFilePath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    console.log(`📝 Remux output path: ${transcodedFilePath}`);
    console.log(`📝 Input file exists: ${fs.existsSync(filePath)}`);

    ffmpeg(filePath)
      .videoCodec('copy')
      .audioCodec('aac')
      .outputOptions([
        '-movflags empty_moov+frag_keyframe',
        '-f mp4'
      ])
      .on('progress', (progress) => {
        remuxProgress.set(moviePath, {
          percent: Math.round(progress.percent || 0),
          frames: progress.frames || 0,
          currentFps: progress.currentFps || 0,
          currentKbps: progress.currentKbps || 0,
          timemark: progress.timemark || '00:00:00'
        });
      })
      .on('error', (err) => {
        console.error(`❌ Remux failed for ${moviePath}:`, err.message);
        remuxingOperations.delete(moviePath);
        remuxProgress.delete(moviePath);
        if (fs.existsSync(transcodedFilePath)) {
          fs.unlinkSync(transcodedFilePath);
        }
      })
      .on('end', () => {
        console.log(`✅ Remux completed: ${transcodedRelativePath}`);
        console.log(`✅ Output file exists: ${fs.existsSync(transcodedFilePath)}`);
        remuxingOperations.delete(moviePath);
        remuxProgress.delete(moviePath);
      })
      .save(transcodedFilePath);
  }

  res.json({ code: finalCode, durationSec, remuxStarted: !isTranscoded && !isRemuxing });
});

// GET /admin/api/codes - List all codes with remux status (local only, JWT required)
app.get('/admin/api/codes', localOnly, verifyAdminJwt, (req, res) => {
  const allCodes = codes.getAllCodes();

  const codesWithStatus = allCodes.map(code => {
    const transcodedRelativePath = getTranscodedPath(code.movie_path);
    const transcodedFilePath = path.join(transcodedDir, transcodedRelativePath);
    const isTranscoded = fs.existsSync(transcodedFilePath);
    const isRemuxing = remuxingOperations.has(code.movie_path);

    return {
      ...code,
      isTranscoded,
      isRemuxing
    };
  });

  res.json({ codes: codesWithStatus });
});

// DELETE /admin/api/codes/:id - Delete a code (local only, JWT required, CSRF protected)
app.delete('/admin/api/codes/:id', localOnly, verifyCsrfToken, verifyAdminJwt, (req, res) => {
  const { id } = req.params;

  if (!id || isNaN(id)) {
    return res.status(400).json({ error: 'Invalid code ID' });
  }

  const codeId = parseInt(id, 10);

  // Get the code before deleting to find movie_path
  const allCodes = codes.getAllCodes();
  const codeToDelete = allCodes.find(c => c.id === codeId);

  if (!codeToDelete) {
    return res.status(404).json({ error: 'Code not found' });
  }

  const moviePath = codeToDelete.movie_path;
  console.log(`🗑️ Deleting code ${codeId} for movie: ${moviePath}`);

  // Delete the code
  codes.deleteCode(codeId);

  // Invalidate any active sessions for this movie
  const sessionsBeforeDeletion = sessions.getAllSessions().filter(s => s.movie_path === moviePath);
  if (sessionsBeforeDeletion.length > 0) {
    console.log(`⚠️ Invalidating ${sessionsBeforeDeletion.length} active session(s) for ${moviePath}`);
    sessions.deleteSessionsByMoviePath(moviePath);
  }

  // Check if any other codes still reference this movie
  const remainingCodes = codes.getAllCodes();
  const otherCodesUsingMovie = remainingCodes.some(c => c.movie_path === moviePath);
  console.log(`📌 Other codes using ${moviePath}: ${otherCodesUsingMovie}`);

  if (!otherCodesUsingMovie) {
    // Sessions have been invalidated above, so now we can safely delete the file
    if (true) {  // Always try to delete since we invalidated sessions
      // Safe to delete the remuxed file
      const transcodedRelativePath = getTranscodedPath(moviePath);
      const transcodedFilePath = path.join(transcodedDir, transcodedRelativePath);
      console.log(`🔍 Checking for remuxed file: ${transcodedFilePath}`);
      console.log(`✅ File exists: ${fs.existsSync(transcodedFilePath)}`);

      if (fs.existsSync(transcodedFilePath)) {
        try {
          fs.unlinkSync(transcodedFilePath);
          console.log(`✅ Deleted remuxed file: ${transcodedRelativePath}`);
        } catch (err) {
          console.error(`❌ Failed to delete remuxed file ${transcodedRelativePath}:`, err);
        }
      } else {
        console.log(`⚠️ Remuxed file not found: ${transcodedFilePath}`);
      }

      // Try to clean up empty parent directory (whether file existed or not)
      const parentDir = path.dirname(transcodedFilePath);
      if (parentDir !== transcodedDir && fs.existsSync(parentDir)) {
        try {
          const files = fs.readdirSync(parentDir);
          if (files.length === 0) {
            fs.rmdirSync(parentDir);
            console.log(`✅ Deleted empty directory: ${parentDir}`);
          }
        } catch (err) {
          // Directory not empty or other error, skip cleanup
        }
      }
    }
  } else {
    console.log(`⚠️ Cannot delete remuxed file - still referenced by other codes`);
  }

  res.json({ success: true });
});

// GET /admin/api/bans - List all IP bans (local only, JWT required)
app.get('/admin/api/bans', localOnly, verifyAdminJwt, (req, res) => {
  const allBans = bans.getAllBans();
  const now = Math.floor(Date.now() / 1000);
  const bansWithStatus = allBans.map(ban => ({
    ...ban,
    isBanned: ban.banned_until && ban.banned_until > now
  }));
  res.json({ bans: bansWithStatus });
});

// DELETE /admin/api/bans/:ip - Unban an IP (local only, JWT required, CSRF protected)
app.delete('/admin/api/bans/:ip', localOnly, verifyCsrfToken, verifyAdminJwt, (req, res) => {
  const { ip } = req.params;

  if (!ip) {
    return res.status(400).json({ error: 'IP required' });
  }

  bans.unbanIp(ip);
  res.json({ success: true });
});

// Helper: Get transcoded path from movie path
function getTranscodedPath(moviePath) {
  const movieDir = path.dirname(moviePath);
  const movieBasename = path.basename(moviePath, path.extname(moviePath));
  return path.join(movieDir === '.' ? '' : movieDir, `${movieBasename}.mp4`);
}

// GET /admin/api/remux-status - Check remux status for all movies
app.get('/admin/api/remux-status', localOnly, verifyAdminJwt, (req, res) => {
  const movies = getMovieFiles();

  const status = movies.map(moviePath => {
    const transcodedRelativePath = getTranscodedPath(moviePath);
    const transcodedFilePath = path.join(transcodedDir, transcodedRelativePath);
    const isTranscoded = fs.existsSync(transcodedFilePath);
    const isRemuxing = remuxingOperations.has(moviePath);

    return {
      moviePath,
      movieName: path.basename(moviePath),
      isTranscoded,
      isRemuxing,
      transcodedPath: transcodedRelativePath
    };
  });

  res.json({ movies: status });
});

// POST /admin/api/remux - Remux a specific movie to MP4 (local only, JWT required, CSRF protected)
app.post('/admin/api/remux', localOnly, verifyCsrfToken, verifyAdminJwt, (req, res) => {
  const { moviePath } = req.body;

  if (!moviePath || typeof moviePath !== 'string') {
    return res.status(400).json({ error: 'Movie path required' });
  }

  // Validate movie path
  if (!validateMoviePath(moviePath)) {
    return res.status(400).json({ error: 'Invalid movie path' });
  }

  const sourceFilePath = path.join(__dirname, 'movies', moviePath);

  if (!fs.existsSync(sourceFilePath)) {
    return res.status(404).json({ error: 'Movie file not found' });
  }

  // Calculate output path
  const transcodedRelativePath = getTranscodedPath(moviePath);
  const transcodedFilePath = path.join(transcodedDir, transcodedRelativePath);

  // Create subdirectories if needed
  const outputDir = path.dirname(transcodedFilePath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Check if already transcoded
  if (fs.existsSync(transcodedFilePath)) {
    return res.json({ status: 'already_exists', message: 'File already transcoded', path: transcodedRelativePath });
  }

  // Check if remux is already in progress
  if (remuxingOperations.has(moviePath)) {
    return res.json({ status: 'already_remuxing', message: 'Remux already in progress', path: transcodedRelativePath });
  }

  // Mark as remuxing
  remuxingOperations.add(moviePath);

  // Start remuxing process (non-blocking)
  console.log(`📝 Starting remux: ${moviePath} -> ${transcodedRelativePath}`);
  console.log(`📝 Input file: ${sourceFilePath} (exists: ${fs.existsSync(sourceFilePath)})`);
  console.log(`📝 Output path: ${transcodedFilePath}`);

  ffmpeg(sourceFilePath)
    .videoCodec('copy')
    .audioCodec('aac')
    .outputOptions([
      '-movflags empty_moov+frag_keyframe',
      '-f mp4'
    ])
    .on('progress', (progress) => {
      remuxProgress.set(moviePath, {
        percent: Math.round(progress.percent || 0),
        frames: progress.frames || 0,
        currentFps: progress.currentFps || 0,
        currentKbps: progress.currentKbps || 0,
        timemark: progress.timemark || '00:00:00'
      });
    })
    .on('error', (err) => {
      console.error(`❌ Remux failed for ${moviePath}:`, err.message);
      remuxingOperations.delete(moviePath);
      remuxProgress.delete(moviePath);
      // Clean up partial file
      if (fs.existsSync(transcodedFilePath)) {
        fs.unlinkSync(transcodedFilePath);
      }
    })
    .on('end', () => {
      console.log(`✅ Remux completed: ${transcodedRelativePath}`);
      console.log(`✅ Output file exists: ${fs.existsSync(transcodedFilePath)}`);
      remuxingOperations.delete(moviePath);
      remuxProgress.delete(moviePath);
    })
    .save(transcodedFilePath);

  res.json({ status: 'remuxing', message: 'Remux started in background', path: transcodedRelativePath });
});

// GET /admin/api/remux-progress - Get progress for all remuxing operations
app.get('/admin/api/remux-progress', localOnly, verifyAdminJwt, (req, res) => {
  const progress = {};

  // Build progress object for all remuxing operations
  remuxingOperations.forEach(moviePath => {
    const movieProgress = remuxProgress.get(moviePath);
    progress[moviePath] = movieProgress || { percent: 0 };
  });

  res.json({ progress });
});

// ============ PERIODIC TASKS ============

// Utility: Get all remuxed files
function getRemuxedFiles(dir) {
  const files = [];
  function scanDir(currentDir, relPath = '') {
    try {
      const entries = fs.readdirSync(currentDir);
      entries.forEach(entry => {
        const fullPath = path.join(currentDir, entry);
        const relPathEntry = relPath ? path.join(relPath, entry) : entry;
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          scanDir(fullPath, relPathEntry);
        } else if (entry.endsWith('.mp4')) {
          files.push({ relativePath: relPathEntry, fullPath });
        }
      });
    } catch (err) {
      console.error(`Error scanning ${currentDir}:`, err);
    }
  }
  scanDir(dir);
  return files;
}

// Utility: Check if a remuxed file is in use by any active session
function isRemuxedFileInUse(moviePath) {
  const allSessions = sessions.getAllSessions();
  return allSessions.some(session => session.movie_path === moviePath);
}

// Clean up expired sessions and unused remuxed files every 10 minutes
setInterval(() => {
  // Delete expired sessions
  sessions.deleteExpiredSessions();

  // Clean up unused remuxed files
  try {
    const remuxedFiles = getRemuxedFiles(transcodedDir);
    remuxedFiles.forEach(file => {
      // Check if this remuxed file corresponds to a movie path in use
      let isInUse = false;

      // Get all original movies
      const movies = getMovieFiles();
      for (const moviePath of movies) {
        const transcodedPath = getTranscodedPath(moviePath);
        if (file.relativePath === transcodedPath || file.relativePath.replace(/\\/g, '/') === transcodedPath.replace(/\\/g, '/')) {
          // Check if any active session uses this movie
          if (isRemuxedFileInUse(moviePath)) {
            isInUse = true;
            break;
          }
        }
      }

      // If not in use, delete it
      if (!isInUse) {
        try {
          fs.unlinkSync(file.fullPath);
          console.log(`Deleted unused remuxed file: ${file.relativePath}`);
        } catch (err) {
          console.error(`Failed to delete remuxed file ${file.relativePath}:`, err);
        }
      }
    });
  } catch (err) {
    console.error('Error during remuxed file cleanup:', err);
  }
}, 10 * 60 * 1000);

// ============ START SERVER ============

app.listen(PORT, () => {
  console.log(`\n🌐 ArkNet Share is running on http://localhost:${PORT}`);
  console.log(`📊 Admin panel: http://localhost:${PORT}/admin (local networks only)\n`);
});
