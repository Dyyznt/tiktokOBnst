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
  // CATATAN: Content-Length dari upstream SENGAJA tidak di-forward.
  // fetch() di edge runtime otomatis men-decompress body kalau upstream
  // ngirim pakai gzip/br, tapi header Content-Length upstream tetap
  // mencerminkan ukuran terkompresi. Kalau header itu diteruskan apa
  // adanya, browser berhenti membaca stream begitu jumlah byte itu
  // tercapai — padahal isi aslinya lebih panjang — hasilnya file audio/
  // video ke-crop/terpotong di tengah. Tanpa header ini, browser otomatis
  // pakai chunked transfer dan membaca stream sampai benar-benar selesai.
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

// Coba resolve link download dari API sumber, dengan auto-retry beberapa
// kali kalau gagal — API pihak ketiga ini kadang gagal sesaat (flaky),
// jadi 1x gagal belum tentu link Spotify-nya salah.
async function resolveSpotifyData(spotifyUrl, maxAttempts = 3) {
  let lastMessage = 'Gagal memproses link. Layanan sumber tidak menemukan file untuk link ini.';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const apiRes = await fetch(`https://api.ikyyxd.my.id/download/spotifydl?url=${encodeURIComponent(spotifyUrl)}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Referer': 'https://api.ikyyxd.my.id/',
        },
      });

      if (!apiRes.ok) {
        lastMessage = `Layanan Spotify sedang bermasalah (kode ${apiRes.status}).`;
      } else {
        let apiData;
        try {
          apiData = await apiRes.json();
        } catch {
          apiData = null;
          lastMessage = 'Layanan Spotify mengirim respons yang tidak valid.';
        }

        if (apiData) {
          const d = apiData.result || apiData.data || apiData;
          const dlUrl = d && (d.download || d.url || d.downloadUrl || d.link);
          if (dlUrl) {
            return { d, dlUrl };
          }
          let extractedMsg = apiData.message || apiData.msg || apiData.error;
          if (extractedMsg && typeof extractedMsg === 'object') {
            try { extractedMsg = JSON.stringify(extractedMsg); } catch { extractedMsg = null; }
          }
          lastMessage = extractedMsg || `Respons API tidak dikenali: ${JSON.stringify(apiData).slice(0, 300)}`;
        }
      }
    } catch {
      lastMessage = 'Gagal menghubungi layanan Spotify.';
    }

    // Jeda sebelum coba lagi — API sumber nge-rate-limit (minimal 1 detik
    // antar request), jadi jeda makin lama tiap percobaan (backoff) biar
    // nggak nabrak limit itu lagi: 1.2s, lalu 2s.
    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, 1200 * attempt));
    }
  }

  const err = new Error(lastMessage);
  throw err;
}

async function handleSpotify(searchParams) {
  const spotifyUrl = searchParams.get('url');
  if (!spotifyUrl || !SPOTIFY_TRACK_URL_RE.test(spotifyUrl)) {
    return jsonError('Link Spotify tidak valid.', 400);
  }

  let resolved;
  try {
    resolved = await resolveSpotifyData(spotifyUrl);
  } catch (err) {
    return jsonError(`Gagal memproses link: ${err.message}`, 502);
  }

  const { d, dlUrl } = resolved;
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

// Sama seperti resolveSpotifyData, tapi buat endpoint search-by-nama-lagu
// (/search/spotifyplay) yang dipakai fitur "Play Spotify" — user gak perlu
// tempel link Spotify, cukup ketik judul lagunya.
async function resolveSpotifySearchData(query, maxAttempts = 3) {
  let lastMessage = 'Gagal memproses pencarian. Layanan sumber tidak menemukan lagu untuk kata kunci ini.';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const apiRes = await fetch(`https://api.ikyyxd.my.id/search/spotifyplay?query=${encodeURIComponent(query)}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Referer': 'https://api.ikyyxd.my.id/',
        },
      });

      if (!apiRes.ok) {
        lastMessage = `Layanan Spotify sedang bermasalah (kode ${apiRes.status}).`;
      } else {
        let apiData;
        try {
          apiData = await apiRes.json();
        } catch {
          apiData = null;
          lastMessage = 'Layanan Spotify mengirim respons yang tidak valid.';
        }

        if (apiData) {
          const d = apiData.result || apiData.data || apiData;
          const dlUrl = d && (d.download || d.url || d.downloadUrl || d.link);
          if (dlUrl) {
            return { d, dlUrl };
          }
          let extractedMsg = apiData.message || apiData.msg || apiData.error;
          if (extractedMsg && typeof extractedMsg === 'object') {
            try { extractedMsg = JSON.stringify(extractedMsg); } catch { extractedMsg = null; }
          }
          lastMessage = extractedMsg || `Respons API tidak dikenali: ${JSON.stringify(apiData).slice(0, 300)}`;
        }
      }
    } catch {
      lastMessage = 'Gagal menghubungi layanan Spotify.';
    }

    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, 1200 * attempt));
    }
  }

  const err = new Error(lastMessage);
  throw err;
}

async function handleSpotifySearch(searchParams) {
  const query = searchParams.get('query');
  if (!query || !query.trim()) {
    return jsonError('Kata kunci pencarian tidak boleh kosong.', 400);
  }

  let resolved;
  try {
    resolved = await resolveSpotifySearchData(query.trim());
  } catch (err) {
    return jsonError(`Gagal memproses pencarian: ${err.message}`, 502);
  }

  const { d, dlUrl } = resolved;
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

// Health-check ringan buat badge status real-time di menu "Lainnya".
// Cuma ngecek reachability domain sumber (HEAD, timeout singkat) — bukan
// full resolve+download (itu makan belasan detik dan boros kuota API),
// jadi ini indikasi kasar "servernya nyala/kebuka", bukan jaminan 100%
// proses download bakal sukses.
async function handleHealth() {
  let spotify = false;
  try {
    const res = await fetch('https://api.ikyyxd.my.id/', {
      method: 'HEAD',
      signal: AbortSignal.timeout(5000),
    });
    spotify = res.ok;
  } catch {
    spotify = false;
  }

  return new Response(JSON.stringify({ spotify }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
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

  if (service === 'spotifyplay') {
    return handleSpotifySearch(searchParams);
  }

  if (service === 'health') {
    return handleHealth();
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
