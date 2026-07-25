// api/proxy.js
// Edge Function — proxy stream file video/audio dari CDN TikTok/tikwm supaya
// jadi same-origin. Ini yang bikin atribut `download` di frontend beneran
// jalan (browser suka skip `download` kalau link-nya lintas domain).
//
// Pakai Edge Runtime (bukan Node serverless biasa) karena Edge Function
// nge-stream response langsung tanpa dibuffer penuh di memory dan tanpa
// limit ukuran body yang berlaku di Node serverless function biasa — jadi
// aman buat file video yang lumayan besar.
export const config = { runtime: 'edge' };

// Whitelist domain — WAJIB ADA. Tanpa ini, endpoint ini jadi "open proxy"
// yang bisa disalahgunakan buat nge-relay request ke domain manapun.
const ALLOWED_HOST_SUFFIXES = [
  'tikwm.com',
  'tiktokcdn.com',
  'tiktokcdn-us.com',
  'tiktokv.com',
  'muscdn.com',
  'ibytedtos.com',
  'ibyteimg.com',
];

function isAllowedHost(hostname) {
  return ALLOWED_HOST_SUFFIXES.some(
    (suf) => hostname === suf || hostname.endsWith('.' + suf)
  );
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ success: false, message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sanitizeAsciiFilename(name, fallback) {
  return (name || fallback).replace(/[^a-zA-Z0-9-_.]/g, '_').slice(0, 100);
}

// Stream response upstream (file audio/video) ke client sebagai attachment,
// same-origin, tanpa pernah membuat browser pindah domain. Header custom
// X-Track-* (kalau dikasih) dipakai frontend buat nampilin info track TANPA
// perlu request/tab kedua.
async function streamUpstream(upstreamUrl, filename, extraHeaders) {
  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
  } catch {
    return jsonError('Gagal menghubungi sumber file.', 502);
  }

  if (!upstream.ok || !upstream.body) {
    return jsonError('Gagal mengambil file dari sumber.', 502);
  }

  const headers = new Headers();
  headers.set('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
  headers.set('Content-Disposition', `attachment; filename="${sanitizeAsciiFilename(filename, 'download')}"`);
  const length = upstream.headers.get('content-length');
  if (length) headers.set('Content-Length', length);
  if (extraHeaders) {
    for (const [key, value] of Object.entries(extraHeaders)) {
      if (value) headers.set(key, value);
    }
  }

  return new Response(upstream.body, { status: 200, headers });
}

// Hanya link track Spotify asli yang boleh dikirim frontend ke sini.
// Link CDN hasil resolve TIDAK PERNAH dikirim balik ke browser sebagai
// redirect — semua resolve + fetch file terjadi di server (edge function).
const SPOTIFY_TRACK_URL_RE = /^https:\/\/open\.spotify\.com\/track\/[a-zA-Z0-9]+(\?.*)?$/;

async function handleSpotify(searchParams) {
  const spotifyUrl = searchParams.get('url');
  if (!spotifyUrl || !SPOTIFY_TRACK_URL_RE.test(spotifyUrl)) {
    return jsonError('Link Spotify tidak valid.', 400);
  }

  let apiRes;
  try {
    apiRes = await fetch(`http://api.ikyyxd.my.id/download/spotifydl?url=${encodeURIComponent(spotifyUrl)}`);
  } catch {
    return jsonError('Gagal menghubungi layanan Spotify.', 502);
  }

  let apiData;
  try {
    apiData = await apiRes.json();
  } catch {
    return jsonError('Respons layanan Spotify tidak valid.', 502);
  }

  const d = apiData.result || apiData.data || apiData;
  const dlUrl = d && (d.download || d.url || d.downloadUrl || d.link);
  if (!dlUrl) {
    return jsonError('Gagal memproses link. Periksa kembali link Spotify.', 502);
  }

  const title = d.title || d.name || 'Spotify Track';
  const artist = d.artist || d.author || d.singer || '';
  const image = d.image || d.thumbnail || d.cover || '';
  const filename = `${title}${artist ? ' - ' + artist : ''}.mp3`;

  return streamUpstream(dlUrl, filename, {
    'X-Track-Title': encodeURIComponent(title),
    'X-Track-Artist': encodeURIComponent(artist),
    'X-Track-Image': encodeURIComponent(image),
    'X-Track-Filename': encodeURIComponent(filename),
  });
}

export default async function handler(req) {
  if (req.method !== 'GET') {
    return jsonError('Method not allowed', 405);
  }

  const { searchParams } = new URL(req.url);
  const service = searchParams.get('service');

  if (service === 'spotify') {
    return handleSpotify(searchParams);
  }

  const target = searchParams.get('url');
  const filename = searchParams.get('filename') || 'orbinest-video';

  if (!target) {
    return jsonError('URL tujuan tidak ada.', 400);
  }

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return jsonError('URL tidak valid.', 400);
  }

  if (!isAllowedHost(parsed.hostname)) {
    return jsonError('Domain sumber tidak diizinkan.', 403);
  }

  return streamUpstream(target, filename);
    }
