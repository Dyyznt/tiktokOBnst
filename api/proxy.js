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

export default async function handler(req) {
  if (req.method !== 'GET') {
    return jsonError('Method not allowed', 405);
  }

  const { searchParams } = new URL(req.url);
  const target = searchParams.get('url');
  const rawFilename = searchParams.get('filename') || 'orbinest-video';
  const filename = rawFilename.replace(/[^a-zA-Z0-9-_.]/g, '_').slice(0, 100);

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

  let upstream;
  try {
    upstream = await fetch(target, {
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
  headers.set('Content-Disposition', `attachment; filename="${filename}"`);
  const length = upstream.headers.get('content-length');
  if (length) headers.set('Content-Length', length);

  return new Response(upstream.body, { status: 200, headers });
}
