# Photography Portfolio CMS

The existing public design and admin CMS are preserved. CMS content now uses Supabase Postgres and uploaded portfolio images use Supabase Storage, so Vercel's ephemeral filesystem is no longer the source of truth.

## Requirements

- Node.js 22.13+
- Supabase project
- Vercel environment variables configured

## Supabase setup

1. Open Supabase SQL Editor.
2. Run `supabase/schema.sql`.
3. In Supabase Settings → API Keys, create/use a server-side **secret key**.
4. Never put that secret key in browser code or GitHub. Supabase documents secret keys as server-only credentials that bypass RLS. citeturn0search9
5. The `portfolio-images` bucket is public because the portfolio images are public. Supabase serves public bucket files through its CDN/public object URL. citeturn0search4

## Environment variables

Set these in Vercel:

- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY`
- `SUPABASE_STORAGE_BUCKET=portfolio-images`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `SESSION_SECRET`
- `AI_API_KEY` (if AI photo analysis is used)
- `AI_PROVIDER=gemini`
- `AI_MODEL=gemini-flash-latest`

Do not commit any real API keys or passwords.

## Run locally

1. Copy `.env.example` to `.env`.
2. Fill in the Supabase URL and server-side secret key.
3. Run `npm install`.
4. Run `npm start`.
5. Open `http://localhost:3000/` or `http://localhost:3000/admin`.

## Persistence architecture

- **Supabase Postgres:** portfolio items, media metadata, sections, site content, navigation, social links, and skills.
- **Supabase Storage:** uploaded JPG, PNG, WebP, and AVIF portfolio images.
- **Vercel:** application/serverless runtime only.
- **Browser:** never receives the Supabase secret key.

Supabase recommends storing large media in Storage rather than in database rows. citeturn0search3

## Existing content

The old Vercel database lived under `/tmp/data/portfolio.sqlite` and old uploads under `/tmp/uploads`. Those locations are ephemeral and cannot be treated as a durable production backup.

If you still have a local copy of the old `data/portfolio.sqlite` and `uploads/` directory, migrate that local copy before switching production traffic. If the only copy existed inside a recycled Vercel function, it cannot be recovered reliably from the old architecture.

## Project structure

- `home.html`, `about.html`, `photography.html`, `hire.html` — public pages
- `admin/` — existing CMS UI
- `Javascript/server-supabase.js` — Supabase-backed API/server
- `Javascript/server.js` — previous SQLite implementation retained for rollback/reference
- `Javascript/ai-photo-service.js` — existing Gemini photo analysis
- `supabase/schema.sql` — database/storage setup
