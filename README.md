# Photography Portfolio CMS

The public pages use CMS data from `/api/public/site`. Run the Node.js server locally or deploy the project to Vercel; opening the HTML files directly or serving them as a static-only site will not load this data or the admin API.

## Requirements

- Node.js 22.13 or newer
- Supabase project with the CMS schema applied (see [Supabase setup](#supabase-setup)).
- npm dependencies installed with `npm install`.

## Run locally

1. Copy `.env.example` to `.env`.
2. Set a unique `ADMIN_USERNAME`, a strong `ADMIN_PASSWORD`, and a `SESSION_SECRET`.
3. Set `SUPABASE_URL` and the server-only `SUPABASE_SECRET_KEY`.
4. Apply the SQL migration and, if needed, import existing SQLite content as described below.
5. Run `npm install` and `npm start`.
6. Open `http://localhost:3000/` for the site or `http://localhost:3000/admin` for the CMS.

Do not open `home.html` with VS Code Live Server (usually port `5500`). Live Server only serves static files and does not provide `/api/public/site`, so the page's CMS content will be missing. Use the Node.js server above and open `http://localhost:3000/home.html` instead.

Supabase Postgres is the source of CMS content. Uploaded image files remain in `uploads/`; only their metadata is stored in Postgres.

## Supabase setup

1. In the Supabase SQL Editor, run [`supabase/migrations/20261003000000_cms_schema.sql`](./supabase/migrations/20261003000000_cms_schema.sql).
2. Set `SUPABASE_URL` and `SUPABASE_SECRET_KEY` in `.env` locally and in the production environment. The secret key is server-only: do not prefix it with `NEXT_PUBLIC_`, place it in frontend code, or commit it.
3. If this project already has CMS records in `data/portfolio.sqlite`, run `npm run import:sqlite` once after applying the schema. The importer is repeatable and upserts by primary key.

The SQL migration enables row-level security without public policies. The Node server uses the secret key only for its server-side database requests; public pages continue to read content through the existing `/api/public/site` endpoint. Admin login and signed session cookies are unchanged.

## Deploy to Vercel

Import this repository into Vercel with the repository root as the project root. Vercel uses `vercel.json` to route public paths and the `/api/*` requests to the serverless handler. The function does not seed demo images or website content; production content must come from the database and CMS.

### Environment Variables on Vercel
When deploying to Vercel (or when `NODE_ENV=production`), the application enforces strict production security and will refuse to start if any of the following variables are missing:
- `ADMIN_USERNAME`: Unique admin username (insecure defaults are rejected in production).
- `ADMIN_PASSWORD`: Strong password of at least 12 characters.
- `SESSION_SECRET`: Dedicated secret key (e.g. 64-character random string from `openssl rand -hex 32`) used to cryptographically sign HMAC-SHA256 session cookies.
- `SUPABASE_URL`: Supabase project URL.
- `SUPABASE_SECRET_KEY`: Server-only Supabase secret key.

Optional AI variables:
- `AI_API_KEY`: Google Gemini API key for photo analysis.
- `AI_PROVIDER`: `gemini` (default).
- `AI_MODEL`: `gemini-2.0-flash` (default).

### Important Architecture & Serverless Limitations
- **Stateless Auth**: Sessions use HMAC-SHA256 signed HttpOnly cookies valid for 8 hours, allowing admin authentication across distributed serverless lambda instances.
- **Ephemeral Uploads**: Uploaded media under `/tmp/uploads` is temporary and may disappear across function restarts. The `portfolio-images` Supabase Storage bucket is not currently used by this app; use durable object storage before relying on production uploads.
- **Brute-Force Rate Limiting**: The login attempt limiter uses an in-memory `Map` within the active Node process. On serverless platforms like Vercel, this memory is not shared across lambda instances, so the in-memory limiter is not effective against distributed attempts across cold starts.


## Project structure

- `home.html`, `about.html`, `photography.html`, and `hire.html` are the public pages.
- `Javascript/public-cms.js` loads and renders CMS data on public pages.
- `Javascript/server.js` implements the API and local Node.js server.
- `api/index.js` is the Vercel serverless entry point.
- `admin/admin.html` and `admin/*.html` provide the admin shell and page templates.
- `css/master.css` contains the public site styles.
