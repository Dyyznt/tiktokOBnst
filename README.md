# OrbiNest (OBNEST)

TikTok video downloader — no-watermark otomatis, lengkap dengan caption, data akun, dan statistik (views, likes, komen, share).

## Deploy ke Vercel

1. Push folder ini ke repo GitHub kamu.
2. Import repo di [vercel.com](https://vercel.com) — gak perlu build command apa-apa, Vercel auto-detect `index.html` + `api/`.
3. (Opsional tapi disarankan) Setup rate limit persisten:
   - Daftar gratis di [upstash.com](https://upstash.com) → buat database Redis
   - Copy `UPSTASH_REDIS_REST_URL` dan `UPSTASH_REDIS_REST_TOKEN` dari tab REST API
   - Masukin ke Vercel → Project Settings → Environment Variables
   - Tanpa ini, rate limit tetap jalan tapi cuma in-memory (reset kalau instance serverless di-recycle)
4. Deploy.

## Development lokal

```
npm install -g vercel
cp .env.example .env.local   # isi kalau mau pakai Upstash
vercel dev
```

## Struktur

```
index.html          → frontend (single file, dark gray minimalist)
api/download.js      → serverless function: fetch data TikTok + rate limit + deteksi spam
api/proxy.js          → edge function: proxy stream video/audio biar tombol download beneran jalan (same-origin)
.env.example          → template env variable
```

## Catatan

- Sumber data video pakai endpoint publik tikwm.com, tidak butuh API key.
- Rate limit default: 10x download per IP / 3 jam, bisa diubah lewat env `RATE_LIMIT_MAX` dan `RATE_LIMIT_WINDOW_SECONDS`.
- Deteksi spam: >3 request dalam 8 detik dianggap spam (terpisah dari kuota total), bisa diubah lewat `BURST_MAX` dan `BURST_WINDOW_MS`.
- `api/proxy.js` cuma bisa proxy dari domain CDN TikTok/tikwm yang di-whitelist — bukan open proxy.
