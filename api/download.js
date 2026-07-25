// api/download.js
// Serverless function (Vercel Node runtime) — proses link TikTok jadi data
// lengkap: video no-watermark, caption, author, dan stats.

const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 10);
const RATE_LIMIT_WINDOW_SECONDS = Number(process.env.RATE_LIMIT_WINDOW_SECONDS || 10800); // 3 jam

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// ── Deteksi spam (burst) ─────────────────────────────────────────────────
// Beda dari rate limit utama (total request per window), ini ngecek POLA:
// beberapa request beruntun dalam waktu sangat singkat = ciri khas spam,
// bukan pemakaian manusia normal (klik → lihat hasil → klik lagi).
// User yang jeda-jeda santai walau sampai 10x tetap dianggap normal.
const BURST_WINDOW_MS = Number(process.env.BURST_WINDOW_MS || 8000); // 8 detik
const BURST_MAX = Number(process.env.BURST_MAX || 3); // maks 3 request dalam window itu
const burstTracker = global.__orbinest_burst || (global.__orbinest_burst = new Map());

function detectSpam(ip) {
  const now = Date.now();
  const timestamps = (burstTracker.get(ip) || []).filter(t => now - t < BURST_WINDOW_MS);
  timestamps.push(now);
  burstTracker.set(ip, timestamps);
  return timestamps.length > BURST_MAX;
}

// ── Rate limit ────────────────────────────────────────────────────────────
// Kalau Upstash Redis di-set (lihat .env.example), limit-nya persisten &
// konsisten lintas region/instance — ini yang dipakai di production.
// Kalau env Upstash kosong, fallback ke in-memory Map supaya project tetap
// jalan tanpa setup tambahan (tapi limit-nya reset kalau instance serverless
// di-recycle — cukup buat testing, bukan buat production beneran).
const memoryHits = global.__orbinest_hits || (global.__orbinest_hits = new Map());

async function checkRateLimitRedis(ip) {
  const key = `orbinest:rl:${ip}`;
  const base = UPSTASH_URL.replace(/\/$/, '');
  const headers = { Authorization: `Bearer ${UPSTASH_TOKEN}` };

  const incrRes = await fetch(`${base}/incr/${key}`, { headers });
  const incrJson = await incrRes.json();
  const count = incrJson.result;

  if (count === 1) {
    await fetch(`${base}/expire/${key}/${RATE_LIMIT_WINDOW_SECONDS}`, { headers });
  }

  if (count > RATE_LIMIT_MAX) {
    const ttlRes = await fetch(`${base}/ttl/${key}`, { headers });
    const ttlJson = await ttlRes.json();
    const ttlSeconds = ttlJson.result > 0 ? ttlJson.result : RATE_LIMIT_WINDOW_SECONDS;
    return { limited: true, resetInMs: ttlSeconds * 1000, remaining: 0 };
  }

  return { limited: false, remaining: Math.max(RATE_LIMIT_MAX - count, 0) };
}

function checkRateLimitMemory(ip) {
  const now = Date.now();
  const windowMs = RATE_LIMIT_WINDOW_SECONDS * 1000;
  const entry = memoryHits.get(ip);

  if (!entry || now - entry.windowStart > windowMs) {
    memoryHits.set(ip, { count: 1, windowStart: now });
    return { limited: false, remaining: Math.max(RATE_LIMIT_MAX - 1, 0) };
  }
  if (entry.count >= RATE_LIMIT_MAX) {
    return { limited: true, resetInMs: windowMs - (now - entry.windowStart), remaining: 0 };
  }
  entry.count += 1;
  return { limited: false, remaining: Math.max(RATE_LIMIT_MAX - entry.count, 0) };
}

async function checkRateLimit(ip) {
  if (UPSTASH_URL && UPSTASH_TOKEN) {
    try {
      return await checkRateLimitRedis(ip);
    } catch {
      // Kalau Redis lagi error, jangan sampai nge-block semua user —
      // fallback ke in-memory sementara.
      return checkRateLimitMemory(ip);
    }
  }
  return checkRateLimitMemory(ip);
}

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function isValidTikTokUrl(url) {
  try {
    const u = new URL(url);
    return /(^|\.)tiktok\.com$/.test(u.hostname);
  } catch {
    return false;
  }
}

function formatWait(ms) {
  const mins = Math.ceil(ms / 60000);
  if (mins < 60) return `${mins} menit`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hrs} jam ${remMins} menit` : `${hrs} jam`;
}

// Sumber data: endpoint publik tikwm.com yang me-resolve video TikTok jadi
// JSON, termasuk versi no-watermark. Tidak butuh API key.
async function resolveTikTok(tiktokUrl) {
  const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(tiktokUrl)}&hd=1`;
  const res = await fetch(apiUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  if (!res.ok) throw new Error('UPSTREAM_ERROR');
  const json = await res.json();
  if (json.code !== 0 || !json.data) throw new Error('NOT_FOUND');
  return json.data;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  const ip = getClientIp(req);
  const { url } = req.body || {};

  if (!url || typeof url !== 'string' || !isValidTikTokUrl(url)) {
    return res.status(400).json({ success: false, message: 'Link TikTok tidak valid.' });
  }

  const isSpam = detectSpam(ip);
  const rl = await checkRateLimit(ip);

  if (isSpam) {
    return res.status(429).json({
      success: false,
      spam: true,
      message: `Anda melakukan spam. Sisa unduhan Anda: ${rl.remaining ?? 0} dari ${RATE_LIMIT_MAX}.`,
    });
  }

  if (rl.limited) {
    return res.status(429).json({
      success: false,
      spam: false,
      message: `Batas ${RATE_LIMIT_MAX}x unduhan tercapai. Silakan coba kembali dalam ${formatWait(rl.resetInMs)}.`,
    });
  }

  try {
    const d = await resolveTikTok(url);
    const isPhotoPost = Array.isArray(d.images) && d.images.length > 0;
    return res.status(200).json({
      success: true,
      data: {
        caption: d.title || '',
        cover: d.cover || d.origin_cover || '',
        images: isPhotoPost ? d.images : undefined,
        video: isPhotoPost ? undefined : {
          noWatermark: d.play || d.hdplay || '',
          watermark: d.wmplay || '',
          resolution: d.hdplay ? 'HD' : 'SD',
        },
        audio: isPhotoPost ? null : (d.music || null),
        author: {
          username: d.author?.unique_id || '',
          nickname: d.author?.nickname || '',
          avatar: d.author?.avatar || '',
        },
        stats: {
          views: d.play_count || 0,
          likes: d.digg_count || 0,
          comments: d.comment_count || 0,
          shares: d.share_count || 0,
        },
      },
    });
  } catch (err) {
    return res.status(502).json({
      success: false,
      message: 'Gagal mengambil data video. Pastikan video publik dan link masih aktif.',
    });
  }
};
  
