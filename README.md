# Photography Portfolio CMS

The public pages use CMS data from `/api/public/site`. Run the Node.js server locally or deploy the project to Vercel; opening the HTML files directly or serving them as a static-only site will not load this data or the admin API.

## Requirements

- Node.js 22.13 or newer
- No npm package installation is required. The server uses Node's built-in SQLite support.

## Run locally

1. Copy `.env.example` to `.env`.
2. Set a unique `ADMIN_USERNAME` and an `ADMIN_PASSWORD` of at least 12 characters.
3. Run `npm start`.
4. Open `http://localhost:3000/` for the site or `http://localhost:3000/admin` for the CMS.

Do not open `home.html` with VS Code Live Server (usually port `5500`). Live Server only serves static files and does not provide `/api/public/site`, so the page's CMS content will be missing. Use the Node.js server above and open `http://localhost:3000/home.html` instead.

The SQLite database is the source of website content. A fresh database starts without portfolio photos, skills, social links, navigation, or sample copy; add real content through the admin CMS. Uploaded images are stored in `uploads/`.

## Deploy to Vercel

Import this repository into Vercel with the repository root as the project root. Vercel uses `vercel.json` to route public paths and the `/api/*` requests to the serverless handler. The function does not seed demo images or website content; production content must come from the database and CMS.

### Environment Variables on Vercel
When deploying to Vercel (or when `NODE_ENV=production`), the application enforces strict production security and will refuse to start if any of the following variables are missing:
- `ADMIN_USERNAME`: Unique admin username (insecure defaults are rejected in production).
- `ADMIN_PASSWORD`: Strong password of at least 12 characters.
- `SESSION_SECRET`: Dedicated secret key (e.g. 64-character random string from `openssl rand -hex 32`) used to cryptographically sign HMAC-SHA256 session cookies.

Optional AI variables:
- `AI_API_KEY`: Google Gemini API key for photo analysis.
- `AI_PROVIDER`: `gemini` (default).
- `AI_MODEL`: `gemini-2.0-flash` (default).

### Important Architecture & Serverless Limitations
- **Stateless Auth**: Sessions use HMAC-SHA256 signed HttpOnly cookies valid for 8 hours, allowing admin authentication across distributed serverless lambda instances.
- **Ephemeral SQLite Database**: The SQLite database on Vercel is stored under `/tmp/data/portfolio.sqlite`. `/tmp` storage is ephemeral and local to each lambda instance; changes made in the admin panel are not shared across serverless instances and are wiped when instances recycle. A hosted database (such as Turso) is required for persistent data in production.
- **Ephemeral Uploads**: Uploaded media under `/tmp/uploads` is similarly temporary and will disappear across function restarts. Object storage (such as Cloudflare R2, AWS S3, or Vercel Blob) is required for durable uploads.
- **Brute-Force Rate Limiting**: The login attempt limiter uses an in-memory `Map` within the active Node process. On serverless platforms like Vercel, this memory is not shared across lambda instances, so the in-memory limiter is not effective against distributed attempts across cold starts.


## Project structure

- `home.html`, `about.html`, `photography.html`, and `hire.html` are the public pages.
- `Javascript/public-cms.js` loads and renders CMS data on public pages.
- `Javascript/server.js` implements the API and local Node.js server.
- `api/index.js` is the Vercel serverless entry point.
- `admin/admin.html` and `admin/*.html` provide the admin shell and page templates.
- `css/master.css` contains the public site styles.
