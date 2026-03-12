# 🌐 ArkNet Share

A secure, one-time-code video streaming application. Share movies with unique 8-character codes that unlock temporary access with full seeking capabilities.

This came about because occasionally I want to share a movie with a friend, but I don't want the hassle of making my JellyFin public, creating their accounts, etc. Plus, I'm paranoid about JellyFin login security. This was the most reasonably secure way I could vibe-implement it while maintaining a full level of control.

1. You (from within a local network) login to the admin panel and select a movie to share with someone. You get a one-time code to send to that person (via text or whatever).
2. The file then gets remuxed into a temp directory.
3. When your friend goes  to the main site, they are able to enter that code and stream the movie. They only have 1.5x the length of the movie access and only for that movie.
4. When the time is up, or you terminate the code (which you can at any time), the file is deleted and access is revoked.
5. I've tried to harden this as much as possible and I run it public-facing for my friends to use at times.
6. Run it from the same machine as your *arrs so it can access the movie files

## Features

- **One-Time Codes**: Each code unlocks a specific movie for one user, one time only
- **Temporary Access**: Sessions expire after video duration × 1.5 (one-time per code)
- **Full Seeking Support**: HTTP 206 range request support for unlimited seeking
- **Auto-Remuxing**: MP4 remuxing on code creation (AAC audio, H.264 video) for reliable streaming
- **Real-Time Progress**: Admin panel shows live remux progress with percentage indicator
- **IP Rate Limiting & Bans**: Auto-ban IPs after 2 failed code attempts (1-hour ban)
- **Admin Panel**: Local network only - manage codes, remux progress, and IP bans
- **Secure Streaming**: JWT + CSRF token validation, token expiration enforced server-side
- **Multi-Format Support**: Supports .mkv, .avi, .mov, .webm, .mp4 (auto-remuxed to MP4)
- **Loading Indicators**: Animated spinners for unlock and video buffering
- **Native HTML5 Player**: Clean dark UI, no external player dependencies

## Tech Stack

- **Runtime**: Node.js 20
- **Server**: Express.js
- **Database**: SQLite (better-sqlite3)
- **Video**: FFmpeg for remuxing to MP4 (copy codec, no re-encoding)
- **Auth**: bcryptjs (password hashing) + jsonwebtoken (JWT)
- **Security**: CSRF tokens + server-side JWT expiration validation
- **Frontend**: Vanilla HTML/CSS/JS, native HTML5 video element

## Project Structure

```
movieshare/
├── server.js              # Express app with all routes
├── db.js                  # SQLite schema and helpers
├── setup.js               # Initial setup (password configuration)
├── package.json
├── Dockerfile
├── docker-compose.yml
├── .env.example           # Environment template
├── public/
│   ├── index.html         # User: code entry + video player
│   └── admin.html         # Admin: code & ban management
├── movies/                # Video files (mounted volume)
├── transcoded/            # Remuxed MP4 files (mounted volume)
└── data/                  # SQLite database (mounted volume)
```

## Setup

### 1. Clone and Install

```bash
git clone <repo>
cd movieshare
cp .env.example .env
npm install
```

### 2. Initial Setup

```bash
node setup.js
```

Follow prompts to:
- Set admin password (minimum 8 characters recommended)
- Generate JWT secret (random 32+ character string)
- Initialize database

### 3. Run Locally (Development)

```bash
npm start
# Server runs on http://localhost:3000
```

- **User page**: http://localhost:3000
- **Admin panel**: http://localhost:3000/admin (local network only)

### 4. Docker Deployment

#### Step 1: Configure Environment

Edit `.env` and set:

```bash
PORT=3000
ADMIN_PASSWORD_HASH=<from setup.js output>
ADMIN_JWT_SECRET=<from setup.js output>
TRANSCODED_VIDEOS_DIR=/app/transcoded
```

#### Step 2: Configure docker-compose.yml Volumes

**IMPORTANT**: Update the volume paths in `docker-compose.yml` to match your system:

```yaml
services:
  movieshare:
    volumes:
      - /your/path/to/movies:/app/movies          # ← Change this to your movies directory
      - /your/path/to/database:/app/data          # ← Change this to your database directory
      - /your/path/to/transcoded:/app/transcoded  # ← Change this to your transcoded files directory
```

#### Step 3: Build and Run

```bash
docker compose build
docker compose up -d
```

#### Step 4: Access

- **User**: http://localhost:3000
- **Admin**: http://localhost:3000/admin (from local network only)

### 5. Behind Reverse Proxy (HTTPS)

For production, run behind a reverse proxy that handles TLS:

```nginx
server {
    listen 443 ssl http2;
    server_name movies.example.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://movieshare:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;

        # Required for video streaming (range requests)
        proxy_buffering off;
        proxy_request_buffering off;
    }
}
```

The app automatically trusts `X-Forwarded-For` headers from reverse proxy and enforces local-network-only access for admin panel.

## API Routes

### Public Routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | User streaming page |
| POST | `/api/redeem` | Redeem code → get session token |
| GET | `/api/stream?token=xxx` | Stream video (requires valid token, supports HTTP 206 range requests) |
| GET | `/api/info?token=xxx` | Get video duration |

### Admin Routes (Local network + JWT + CSRF token required)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin` | Admin panel |
| GET | `/admin/api/csrf-token` | Get CSRF token for state-changing operations |
| POST | `/admin/login` | Login with password → get JWT |
| GET | `/admin/api/movies` | List available video files |
| POST | `/admin/api/codes` | Create new code for a movie (triggers auto-remux) |
| GET | `/admin/api/codes` | List all codes with remux status |
| GET | `/admin/api/remux-progress` | Get real-time remux progress (%) |
| POST | `/admin/api/remux` | Manually trigger remux for a movie |
| DELETE | `/admin/api/codes/:id` | Delete code + invalidate sessions + cleanup remuxed file |
| GET | `/admin/api/bans` | List IP bans |
| DELETE | `/admin/api/bans/:ip` | Unban an IP |

## Usage

### For Sharing a Movie

1. Open http://192.168.x.x:3000/admin (on local network)
2. Enter admin password
3. Select a movie from the dropdown
4. (Optional) Enter custom 8-character code, or leave blank for auto-generated
5. Click "Create Code"
   - Status shows "⏳ Remuxing..." with live progress bar
   - Status changes to "✓ Ready" when complete
6. Copy the 8-character code and share with viewer

### For Watching a Movie

1. Open http://192.168.x.x:3000 in browser
2. Enter the 8-character code
3. See "🔓 Unlocking..." then "📽️ Loading video..."
4. Video auto-plays with full playback controls:
   - Play/Pause
   - **Seek anywhere** (HTTP 206 range requests)
   - Volume control
   - Fullscreen
5. Session expires after video duration × 1.5
6. Click "Enter a Different Code" to redeem another code

### For Revoking Access

1. In admin panel, find the code in the list
2. Click the "Delete" button
3. All active sessions using that code are immediately invalidated
4. Remuxed file is automatically deleted if no other codes reference it

## Video Format Support

The app supports any FFmpeg-compatible format. All videos are remuxed (not re-encoded) to MP4:

- **MP4** (.mp4) - Remuxed for consistency
- **Matroska** (.mkv) - Remuxed to H.264/AAC MP4
- **AVI** (.avi) - Remuxed to MP4
- **MOV** (.mov) - Remuxed to MP4
- **WebM** (.webm) - Remuxed to MP4

**Remuxing**: FFmpeg copies video and audio streams without re-encoding (fast and lossless). AAC audio is re-encoded for MP4 compatibility. Remuxed files are cached in `/app/transcoded/` and auto-deleted when the code is revoked.

## Environment Variables

```bash
PORT=3000                              # Server port (default: 3000)
ADMIN_PASSWORD_HASH=<bcrypt hash>      # Bcrypt hash of admin password
ADMIN_JWT_SECRET=<random string>       # Random 32+ char secret for JWT signing
```

**Generated automatically** during `node setup.js`.

## Database Schema

### codes table
- `id` (primary key)
- `code` (8-char alphanumeric, unique)
- `movie_path` (relative path in movies/)
- `movie_name` (display name)
- `duration_sec` (video length in seconds)
- `used` (0=unused, 1=redeemed)
- `created_at`, `redeemed_at` (unix timestamps)

### sessions table
- `id` (primary key)
- `token` (64-char hex, unique)
- `movie_path` (path to video file)
- `expires_at` (unix timestamp)
- `created_at` (unix timestamp)

### ip_bans table
- `ip` (primary key)
- `failed_attempts` (count of wrong code attempts)
- `banned_until` (unix timestamp, NULL if not banned)

## Security

### ✅ Implemented

- **One-time codes**: Code marked used after first redemption
- **CSRF Protection**: Tokens required for all state-changing operations (POST, PUT, DELETE)
- **JWT Validation**: Admin routes require signed JWT token (expires in 8 hours)
- **Server-side expiration**: Session tokens validated on server (expires after video duration × 1.5)
- **Local-only admin access**: Admin panel restricted to private IPs (127.0.0.1, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
- **Rate limiting**: 10 redeem attempts per IP per minute
- **IP auto-ban**: 2 incorrect/reused codes → 1-hour ban
- **File path validation**: Directory traversal prevention
- **Prepared SQL statements**: SQL injection prevention
- **Password hashing**: bcryptjs with salt
- **Security headers**: CSP, X-Frame-Options, X-Content-Type-Options, X-XSS-Protection
- **Session invalidation**: Deleting a code invalidates all active viewer sessions
- **Auto-cleanup**: Remuxed files deleted when code is revoked and no other codes reference them

### ⚠️ Limitations

- Admin panel accessible to any device on **same local network** (physical network security recommended)
- Codes are 8 characters (2.8 × 10¹³ possibilities)
- IP bans are in-memory (reset on server restart) - use persistent storage if you have a concern
- **No HTTPS by default** - deploy behind reverse proxy with TLS for production

## Performance Notes

- **Remuxing speed**: Depends on video duration and disk speed. Typically 10-100x real-time (copy codec is very fast)
- **Streaming**: Direct MP4 streaming supports seeking to any position instantly (HTTP 206)
- **Concurrent streams**: Can serve multiple users simultaneously; limited by CPU and network bandwidth
- **Disk usage**: Remuxed files are same size as originals (streams are copied, not re-encoded)

## License

MIT