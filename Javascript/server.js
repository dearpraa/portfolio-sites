try {
  if (typeof process.loadEnvFile === "function") process.loadEnvFile();
} catch {}

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { analyzePhoto } = require("./ai-photo-service.js");

const ROOT = path.resolve(__dirname, "..");
const IS_VERCEL = Boolean(process.env.VERCEL);
const DATA_DIR = IS_VERCEL ? "/tmp/data" : path.join(ROOT, "data");
const UPLOAD_DIR = IS_VERCEL ? "/tmp/uploads" : path.join(ROOT, "uploads");
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "portfolio.sqlite");
const PORT = Number(process.env.PORT || 3000);
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
const SESSION_TTL = 8 * 60 * 60 * 1000;
const RESERVED_SLUGS = new Set([
  "homepage", "portfolio", "gallery", "featured", "about", "contact",
]);
const SESSION_COOKIE = "photography_admin";
const ALLOWED_IMAGE_TYPES = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
  ["image/avif", ".avif"],
]);

const IS_PROD = IS_VERCEL || process.env.NODE_ENV === "production";

if (IS_PROD) {
  const missing = [
    !process.env.SESSION_SECRET && "SESSION_SECRET",
    !process.env.ADMIN_USERNAME && "ADMIN_USERNAME",
    !process.env.ADMIN_PASSWORD && "ADMIN_PASSWORD",
  ].filter(Boolean);
  if (missing.length > 0) {
    const msg = `Refusing to start: missing required environment variable(s) in production: ${missing.join(", ")}`;
    console.error(msg);
    throw new Error(msg);
  }
  if (process.env.ADMIN_PASSWORD.length < 8) {
    const msg = "ADMIN_PASSWORD must be at least 8 characters in production.";
    console.error(msg);
    throw new Error(msg);
  }
} else {
  if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) {
    console.error("Set ADMIN_USERNAME and ADMIN_PASSWORD in .env before starting the CMS.");
    process.exit(1);
  }
  if (process.env.ADMIN_PASSWORD.length < 8) {
    console.error("ADMIN_PASSWORD must be at least 8 characters.");
    process.exit(1);
  }
}

const SESSION_SECRET = process.env.SESSION_SECRET || "dev-insecure-session-secret-local-only";

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Vercel instances start with an empty database unless DB_PATH points to a persistent database.
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");

db.exec(`
  CREATE TABLE IF NOT EXISTS media (
    id TEXT PRIMARY KEY,
    file_name TEXT NOT NULL,
    file_url TEXT NOT NULL UNIQUE,
    mime_type TEXT NOT NULL,
    alt_text TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ai_metadata TEXT
  );
  CREATE TABLE IF NOT EXISTS sections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    slug TEXT NOT NULL UNIQUE,
    is_visible INTEGER NOT NULL DEFAULT 1,
    display_order INTEGER NOT NULL DEFAULT 0,
    is_system INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS portfolio_items (
    id TEXT PRIMARY KEY,
    media_id TEXT NOT NULL REFERENCES media(id) ON DELETE RESTRICT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    photo_date TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '',
    is_featured INTEGER NOT NULL DEFAULT 0,
    is_published INTEGER NOT NULL DEFAULT 0,
    display_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS portfolio_item_sections (
    portfolio_item_id TEXT NOT NULL REFERENCES portfolio_items(id) ON DELETE CASCADE,
    section_id TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
    PRIMARY KEY (portfolio_item_id, section_id)
  );
  CREATE TABLE IF NOT EXISTS social_links (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    display_name TEXT NOT NULL,
    url TEXT NOT NULL,
    icon TEXT NOT NULL,
    is_visible INTEGER NOT NULL DEFAULT 1,
    display_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS social_link_locations (
    social_link_id TEXT NOT NULL REFERENCES social_links(id) ON DELETE CASCADE,
    location TEXT NOT NULL,
    display_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (social_link_id, location)
  );
  CREATE TABLE IF NOT EXISTS site_content (
    content_key TEXT PRIMARY KEY,
    content_value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS navigation_items (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    url TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT '',
    is_visible INTEGER NOT NULL DEFAULT 1,
    display_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    percent INTEGER NOT NULL DEFAULT 80,
    icon TEXT NOT NULL DEFAULT 'ri-star-line',
    display_order INTEGER NOT NULL DEFAULT 0,
    is_visible INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS portfolio_published_order
    ON portfolio_items (is_published, display_order);
  CREATE INDEX IF NOT EXISTS portfolio_sections_section
    ON portfolio_item_sections (section_id);
  CREATE INDEX IF NOT EXISTS social_locations
    ON social_link_locations (location);
`);

const portfolioColumns = db.prepare("PRAGMA table_info(portfolio_items)").all();
if (!portfolioColumns.some((column) => column.name === "is_hidden")) {
  db.exec("ALTER TABLE portfolio_items ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0");
}

const mediaColumns = db.prepare("PRAGMA table_info(media)").all();
if (!mediaColumns.some((column) => column.name === "ai_metadata")) {
  db.exec("ALTER TABLE media ADD COLUMN ai_metadata TEXT");
}

// The database is intentionally content-empty on first startup.
// Only the built-in display locations required by the public site are initialized.
const systemSectionsCount = db.prepare("SELECT COUNT(*) AS count FROM sections WHERE is_system = 1").get();
if (systemSectionsCount.count === 0) {
  const insertSystemSection = db.prepare(
    "INSERT OR IGNORE INTO sections (id, name, title, description, slug, display_order, is_system) VALUES (?, ?, ?, '', ?, ?, 1)",
  );
  [
    ["home", "Homepage", "Homepage", "homepage", 0],
    ["portfolio", "Portfolio", "Portfolio", "portfolio", 1],
    ["gallery", "Gallery", "Gallery", "gallery", 2],
    ["featured", "Featured", "Featured", "featured", 3],
    ["about", "About", "About", "about", 4],
    ["contact", "Contact", "Contact", "contact", 5],
  ].forEach((section) => insertSystemSection.run(...section));
}

const loginAttempts = new Map();
const aiAnalysisCooldowns = new Map();
const MIME_BY_EXTENSION = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".avif", "image/avif"],
  [".ico", "image/x-icon"],
]);

function sendJson(res, status, payload, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  return res.end(JSON.stringify(payload));
}

function readBody(req, limit = MAX_UPLOAD_BYTES + 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("Request body is too large."), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req, 1024 * 1024);
  try {
    return JSON.parse(raw.toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON."), { status: 400 });
  }
}

function parseMultipart(buffer, contentType) {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) throw Object.assign(new Error("Missing multipart boundary."), { status: 400 });
  const boundary = Buffer.from(`--${boundaryMatch[1] || boundaryMatch[2]}`);
  const fields = {};
  const files = [];
  let cursor = buffer.indexOf(boundary);
  while (cursor !== -1) {
    cursor += boundary.length;
    if (buffer.subarray(cursor, cursor + 2).equals(Buffer.from("--"))) break;
    if (buffer.subarray(cursor, cursor + 2).equals(Buffer.from("\r\n"))) cursor += 2;
    const headerEnd = buffer.indexOf(Buffer.from("\r\n\r\n"), cursor);
    if (headerEnd === -1) break;
    const headerText = buffer.subarray(cursor, headerEnd).toString("utf8");
    const contentStart = headerEnd + 4;
    const nextBoundary = buffer.indexOf(Buffer.concat([Buffer.from("\r\n"), boundary]), contentStart);
    if (nextBoundary === -1) break;
    const disposition = headerText.match(/content-disposition:\s*form-data;([^\r\n]+)/i)?.[1] || "";
    const nameMatch = disposition.match(/(?:^|;)\s*name=(?:"([^"]*)"|([^;]*))/i);
    const filenameMatch = disposition.match(/(?:^|;)\s*filename=(?:"([^"]*)"|([^;]*))/i);
    const name = (nameMatch?.[1] ?? nameMatch?.[2])?.trim();
    const filename = (filenameMatch?.[1] ?? filenameMatch?.[2])?.trim();
    const data = buffer.subarray(contentStart, nextBoundary);
    if (name && filename !== undefined && filename !== "") {
      const rawType = headerText.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim().toLowerCase() || "";
      let type = rawType.split(";")[0].trim();
      if (type === "image/jpg" || type === "image/pjpeg") type = "image/jpeg";
      files.push({ name, filename: path.basename(filename), type, data });
    } else if (name) {
      const value = data.toString("utf8");
      if (Object.hasOwn(fields, name)) {
        fields[name] = Array.isArray(fields[name]) ? [...fields[name], value] : [fields[name], value];
      } else {
        fields[name] = value;
      }
    }
    cursor = nextBoundary + 2;
  }
  return { fields, files };
}

function serializePortfolioItem(row) {
  return {
    id: row.id,
    mediaId: row.media_id,
    imageUrl: row.file_url,
    fileName: row.file_name,
    mimeType: row.mime_type,
    altText: row.alt_text || "",
    aiMetadata: row.ai_metadata || null,
    title: row.title,
    description: row.description,
    category: row.category,
    location: row.location,
    photoDate: row.photo_date,
    tags: row.tags ? row.tags.split(",").map((tag) => tag.trim()).filter(Boolean) : [],
    featured: Boolean(row.is_featured),
    published: Boolean(row.is_published),
    hidden: Boolean(row.is_hidden),
    displayOrder: row.display_order,
    sections: row.sections ? row.sections.split(",") : [],
  };
}

const portfolioSelect = `
  SELECT p.*, m.file_name, m.file_url, m.mime_type, m.alt_text, m.ai_metadata,
    GROUP_CONCAT(s.slug) AS sections
  FROM portfolio_items p
  JOIN media m ON m.id = p.media_id
  LEFT JOIN portfolio_item_sections ps ON ps.portfolio_item_id = p.id
  LEFT JOIN sections s ON s.id = ps.section_id
`;

function getPortfolioItem(id) {
  const row = db.prepare(`${portfolioSelect} WHERE p.id = ? GROUP BY p.id`).get(id);
  return row ? serializePortfolioItem(row) : null;
}

function getPortfolioItems({ publicOnly = false } = {}) {
  const where = publicOnly ? "WHERE p.is_published = 1 AND p.is_hidden = 0" : "";
  return db.prepare(`${portfolioSelect} ${where} GROUP BY p.id ORDER BY p.display_order, p.created_at`).all()
    .map(serializePortfolioItem);
}

function getSections() {
  return db.prepare("SELECT * FROM sections ORDER BY display_order, name")
    .all()
    .map((section) => ({
      ...section,
      visible: Boolean(section.is_visible),
      system: Boolean(section.is_system),
    }));
}

function getSocialLinks() {
  return db.prepare(`
    SELECT sl.*, GROUP_CONCAT(sll.location) AS locations
    FROM social_links sl
    LEFT JOIN social_link_locations sll ON sll.social_link_id = sl.id
    GROUP BY sl.id
    ORDER BY sl.display_order, sl.display_name
  `).all().map((link) => ({
    id: link.id,
    platform: link.platform,
    displayName: link.display_name,
    url: link.url,
    icon: link.icon,
    visible: Boolean(link.is_visible),
    displayOrder: link.display_order,
    locations: link.locations ? link.locations.split(",") : [],
  }));
}

function getNavigation() {
  return db.prepare("SELECT id, label, url, icon, is_visible AS visible, display_order AS displayOrder FROM navigation_items ORDER BY display_order, label")
    .all()
    .map((item) => ({ ...item, visible: Boolean(item.visible) }));
}

function getContent() {
  return Object.fromEntries(
    db.prepare("SELECT content_key, content_value FROM site_content").all()
      .map((row) => [row.content_key, row.content_value]),
  );
}

function getSkills({ visibleOnly = false } = {}) {
  const where = visibleOnly ? "WHERE is_visible = 1" : "";
  return db.prepare(`SELECT * FROM skills ${where} ORDER BY display_order, name`)
    .all()
    .map((row) => ({
      id: row.id,
      name: row.name,
      percent: row.percent,
      icon: row.icon,
      displayOrder: row.display_order,
      visible: Boolean(row.is_visible),
    }));
}

function createSessionToken(username) {
  const expiresAt = Date.now() + SESSION_TTL;
  const payload = Buffer.from(JSON.stringify({ u: username, exp: expiresAt }), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== "string") return null;
  const dotIndex = token.lastIndexOf(".");
  if (dotIndex === -1) return null;
  const payloadB64 = token.slice(0, dotIndex);
  const signature = token.slice(dotIndex + 1);
  if (!payloadB64 || !signature) return null;

  const expectedSignature = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(payloadB64)
    .digest("base64url");

  const sigBuf = Buffer.from(signature, "utf8");
  const expBuf = Buffer.from(expectedSignature, "utf8");
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  try {
    const data = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    if (!data || typeof data !== "object") return null;
    if (typeof data.exp !== "number" || data.exp < Date.now()) return null;
    if (typeof data.u !== "string" || data.u !== process.env.ADMIN_USERNAME) return null;
    return { username: data.u, expiresAt: data.exp };
  } catch {
    return null;
  }
}

function getSession(req) {
  const cookie = req.headers.cookie || "";
  const rawToken = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`))?.[1];
  if (!rawToken) return null;
  const token = decodeURIComponent(rawToken);
  const verified = verifySessionToken(token);
  if (!verified) return null;
  const key = crypto.createHash("sha256").update(token).digest("hex");
  return { key, session: verified };
}

function requireAdmin(req, res) {
  if (!getSession(req)) {
    sendJson(res, 401, { error: "Authentication required." });
    return false;
  }
  return true;
}

function isSecureRequest(req) {
  if (IS_VERCEL) {
    return req.headers["x-forwarded-proto"]?.split(",")[0].trim() === "https";
  }
  return Boolean(req.socket.encrypted);
}

function checkOrigin(req, res) {
  const origin = req.headers.origin;
  if (origin) {
    const forwardedProto = IS_VERCEL && req.headers["x-forwarded-proto"]
      ? req.headers["x-forwarded-proto"].split(",")[0].trim()
      : "";
    const forwardedHost = IS_VERCEL && req.headers["x-forwarded-host"]
      ? req.headers["x-forwarded-host"].split(",")[0].trim()
      : "";
    const scheme = forwardedProto || (isSecureRequest(req) ? "https" : "http");
    const host = forwardedHost || req.headers.host;
    let matchesOrigin = false;
    try {
      const parsedOrigin = new URL(origin);
      const expectedOrigin = new URL(`${scheme}://${host}`);
      matchesOrigin = parsedOrigin.origin === expectedOrigin.origin
        && parsedOrigin.pathname === "/"
        && !parsedOrigin.search
        && !parsedOrigin.hash;
    } catch {
      matchesOrigin = false;
    }
    if (!matchesOrigin) {
      sendJson(res, 403, { error: "Cross-origin write requests are not allowed." });
      return false;
    }
  }
  return true;
}

function parseLocations(body) {
  const selected = Array.isArray(body.sections) ? body.sections : [];
  const known = new Set(getSections().map((section) => section.slug));
  const unique = [...new Set(selected.map(String))];
  if (unique.some((slug) => !known.has(slug))) {
    throw Object.assign(new Error("One or more selected display locations do not exist."), { status: 400 });
  }
  return unique;
}

function validateExternalUrl(value, schemes = ["https:"]) {
  try {
    const parsed = new URL(String(value));
    if (!schemes.includes(parsed.protocol)) throw new Error();
    return parsed.href;
  } catch {
    throw Object.assign(new Error("Enter a valid URL using an allowed protocol."), { status: 400 });
  }
}

function saveLocations(itemId, locations) {
  db.prepare("DELETE FROM portfolio_item_sections WHERE portfolio_item_id = ?").run(itemId);
  const add = db.prepare("INSERT INTO portfolio_item_sections (portfolio_item_id, section_id) VALUES (?, ?)");
  for (const slug of locations) {
    const section = db.prepare("SELECT id FROM sections WHERE slug = ?").get(slug);
    add.run(itemId, section.id);
  }
}

function assignSocialLocations(linkId, locations) {
  const allowed = new Set(["header", "homepage", "about", "portfolio", "contact", "footer"]);
  if (locations.some((location) => !allowed.has(location))) {
    throw Object.assign(new Error("Unknown social display location."), { status: 400 });
  }
  db.prepare("DELETE FROM social_link_locations WHERE social_link_id = ?").run(linkId);
  const add = db.prepare("INSERT INTO social_link_locations (social_link_id, location, display_order) VALUES (?, ?, ?)");
  locations.forEach((location, index) => add.run(linkId, location, index));
}

function mediaUsage(mediaId) {
  const rows = db.prepare(`
    SELECT p.id, p.title, p.is_published, s.slug
    FROM portfolio_items p
    LEFT JOIN portfolio_item_sections ps ON ps.portfolio_item_id = p.id
    LEFT JOIN sections s ON s.id = ps.section_id
    WHERE p.media_id = ?
    ORDER BY p.display_order
  `).all(mediaId);
  return rows;
}

function deleteOwnedFile(fileUrl) {
  if (!fileUrl.startsWith("/uploads/")) return;
  const fileName = path.basename(decodeURIComponent(fileUrl));
  const filePath = path.join(UPLOAD_DIR, fileName);
  if (path.dirname(filePath) === UPLOAD_DIR) fs.rmSync(filePath, { force: true });
}

function handleAdminApi(req, res, url) {
  const pathname = url.pathname;
  if (pathname === "/api/auth/session" && req.method === "GET") {
    const session = getSession(req);
    return sendJson(res, 200, { authenticated: Boolean(session), username: session?.session.username || null });
  }
  if (pathname === "/api/auth/login" && req.method === "POST") {
    const ip = req.socket.remoteAddress || "unknown";
    const attempts = loginAttempts.get(ip) || { count: 0, until: Date.now() + 15 * 60 * 1000 };
    if (attempts.until < Date.now()) {
      attempts.count = 0;
      attempts.until = Date.now() + 15 * 60 * 1000;
    }
    if (attempts.count >= 8) return sendJson(res, 429, { error: "Too many login attempts. Try again later." });
    return readJson(req).then(({ username, password }) => {
      const providedNormalized = String(username || "").trim().toLowerCase();
      const configuredNormalized = String(process.env.ADMIN_USERNAME || "").trim().toLowerCase();
      const providedUsernameHash = crypto.createHash("sha256").update(providedNormalized).digest();
      const configuredUsernameHash = crypto.createHash("sha256").update(configuredNormalized).digest();
      const altProvidedHash = crypto.createHash("sha256").update(providedNormalized.replace(",", ".")).digest();
      const altConfiguredHash = crypto.createHash("sha256").update(configuredNormalized.replace(",", ".")).digest();
      const validUser = (providedUsernameHash.length === configuredUsernameHash.length && crypto.timingSafeEqual(providedUsernameHash, configuredUsernameHash))
        || (altProvidedHash.length === altConfiguredHash.length && crypto.timingSafeEqual(altProvidedHash, altConfiguredHash));
      const salt = process.env.ADMIN_PASSWORD_SALT || "local-cms-install";
      const expectedHash = crypto.scryptSync(process.env.ADMIN_PASSWORD, salt, 64);
      const actualHash = crypto.scryptSync(String(password || ""), salt, 64);
      const validPassword = crypto.timingSafeEqual(expectedHash, actualHash);
      if (!validUser || !validPassword) {
        attempts.count += 1;
        loginAttempts.set(ip, attempts);
        return sendJson(res, 401, { error: "Username or password is incorrect." });
      }
      loginAttempts.delete(ip);
      const adminUser = process.env.ADMIN_USERNAME;
      const token = createSessionToken(adminUser);
      return sendJson(res, 200, { authenticated: true, username: adminUser }, {
        "Set-Cookie": `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}${isSecureRequest(req) ? "; Secure" : ""}`,
      });
    }).catch((error) => sendJson(res, error.status || 400, { error: error.message }));
  }
  if (pathname === "/api/auth/logout" && req.method === "POST") {
    return sendJson(res, 200, { authenticated: false }, {
      "Set-Cookie": `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${isSecureRequest(req) ? "; Secure" : ""}`,
    });
  }
  if (!pathname.startsWith("/api/admin/")) return null;
  if (!requireAdmin(req, res)) return true;

  if (pathname === "/api/admin/dashboard" && req.method === "GET") {
    const count = (sql) => db.prepare(sql).get().count;
    return sendJson(res, 200, {
      totalPhotos: count("SELECT COUNT(*) AS count FROM portfolio_items"),
      publishedPhotos: count("SELECT COUNT(*) AS count FROM portfolio_items WHERE is_published = 1 AND is_hidden = 0"),
      draftPhotos: count("SELECT COUNT(*) AS count FROM portfolio_items WHERE is_published = 0"),
      featuredPhotos: count("SELECT COUNT(*) AS count FROM portfolio_items WHERE is_featured = 1"),
      skills: count("SELECT COUNT(*) AS count FROM skills"),
      socialLinks: count("SELECT COUNT(*) AS count FROM social_links"),
      navigationItems: count("SELECT COUNT(*) AS count FROM navigation_items"),
    });
  }
  if (pathname === "/api/admin/portfolio" && req.method === "GET") {
    return sendJson(res, 200, getPortfolioItems());
  }
  if (pathname === "/api/admin/portfolio" && req.method === "POST") {
    return handlePortfolioWrite(req, res, null);
  }
  const portfolioMatch = pathname.match(/^\/api\/admin\/portfolio\/([a-f0-9-]+)$/i);
  if (portfolioMatch && req.method === "PUT") return handlePortfolioWrite(req, res, portfolioMatch[1]);
  if (portfolioMatch && req.method === "DELETE") return handlePortfolioDelete(res, portfolioMatch[1]);

  if (pathname === "/api/admin/sections" && req.method === "GET") return sendJson(res, 200, getSections());
  if (pathname === "/api/admin/sections" && req.method === "POST") return handleSectionWrite(req, res, null);
  const sectionMatch = pathname.match(/^\/api\/admin\/sections\/([a-z0-9-]+)$/i);
  if (sectionMatch && req.method === "PUT") return handleSectionWrite(req, res, sectionMatch[1]);
  if (sectionMatch && req.method === "DELETE") return handleSectionDelete(res, sectionMatch[1]);

  if (pathname === "/api/admin/content" && req.method === "GET") return sendJson(res, 200, getContent());
  if (pathname === "/api/admin/content" && req.method === "PUT") return handleContentWrite(req, res);

  if (pathname === "/api/admin/social" && req.method === "GET") return sendJson(res, 200, getSocialLinks());
  if (pathname === "/api/admin/social" && req.method === "POST") return handleSocialWrite(req, res, null);
  const socialMatch = pathname.match(/^\/api\/admin\/social\/([a-z0-9-]+)$/i);
  if (socialMatch && req.method === "PUT") return handleSocialWrite(req, res, socialMatch[1]);
  if (socialMatch && req.method === "DELETE") {
    db.prepare("DELETE FROM social_links WHERE id = ?").run(socialMatch[1]);
    return sendJson(res, 200, { deleted: true });
  }

  if (pathname === "/api/admin/navigation" && req.method === "GET") return sendJson(res, 200, getNavigation());
  if (pathname === "/api/admin/navigation" && req.method === "POST") return handleNavigationWrite(req, res, null);
  const navigationMatch = pathname.match(/^\/api\/admin\/navigation\/([a-z0-9-]+)$/i);
  if (navigationMatch && req.method === "PUT") return handleNavigationWrite(req, res, navigationMatch[1]);
  if (navigationMatch && req.method === "DELETE") {
    db.prepare("DELETE FROM navigation_items WHERE id = ?").run(navigationMatch[1]);
    return sendJson(res, 200, { deleted: true });
  }

  if (pathname === "/api/admin/media" && req.method === "GET") {
    const rows = db.prepare(`
      SELECT m.*, COUNT(DISTINCT p.id) AS item_count
      FROM media m LEFT JOIN portfolio_items p ON p.media_id = m.id
      GROUP BY m.id ORDER BY m.created_at DESC
    `).all().map((row) => ({ ...row, usage: mediaUsage(row.id) }));
    return sendJson(res, 200, rows);
  }
  const mediaMatch = pathname.match(/^\/api\/admin\/media\/([a-f0-9-]+)$/i);
  if (mediaMatch && req.method === "GET") {
    const media = db.prepare("SELECT * FROM media WHERE id = ?").get(mediaMatch[1]);
    if (!media) return sendJson(res, 404, { error: "Media item not found." });
    return sendJson(res, 200, { ...media, usage: mediaUsage(mediaMatch[1]) });
  }
  if (mediaMatch && req.method === "DELETE") return handleMediaDelete(res, mediaMatch[1], url.searchParams.get("mode"));
  if (mediaMatch && req.method === "PATCH") return handleMediaEdit(req, res, mediaMatch[1]);
  if (mediaMatch && req.method === "PUT") return handleMediaReplace(req, res, mediaMatch[1]);

  if (pathname === "/api/admin/ai/analyze-photo" && req.method === "POST") {
    return handleAiAnalyze(req, res);
  }

  // ── Skills CRUD ──────────────────────────────────────────────────────────
  if (pathname === "/api/admin/skills" && req.method === "GET") {
    return sendJson(res, 200, getSkills());
  }
  if (pathname === "/api/admin/skills" && req.method === "POST") {
    return handleSkillWrite(req, res, null);
  }
  const skillMatch = pathname.match(/^\/api\/admin\/skills\/([a-z0-9-]+)$/i);
  if (skillMatch && req.method === "PUT")    return handleSkillWrite(req, res, skillMatch[1]);
  if (skillMatch && req.method === "DELETE") {
    const deleted = db.prepare("DELETE FROM skills WHERE id = ?").run(skillMatch[1]);
    if (deleted.changes === 0) return sendJson(res, 404, { error: "Skill not found." });
    return sendJson(res, 200, { deleted: true });
  }

  return sendJson(res, 404, { error: "Admin API route not found." });
}

async function handleSkillWrite(req, res, id) {
  try {
    const body = await readJson(req);
    const name = String(body.name || "").trim();
    if (!name || name.length > 60) {
      return sendJson(res, 400, { error: "Skill name must be 1-60 characters." });
    }
    const rawPercent = body.percent ?? 80;
    // Reject non-integer numbers (80.5) and non-numeric strings ("abc")
    if (typeof rawPercent === "number" && !Number.isInteger(rawPercent)) {
      return sendJson(res, 400, { error: "Percent must be an integer from 0 to 100." });
    }
    const percentStr = String(rawPercent).trim();
    const percent = Number(percentStr);
    if (!Number.isInteger(percent) || isNaN(percent) || percent < 0 || percent > 100) {
      return sendJson(res, 400, { error: "Percent must be an integer from 0 to 100." });
    }
    const icon = String(body.icon || "ri-star-line").trim();
    if (!/^ri-[a-z0-9-]+$/.test(icon)) {
      return sendJson(res, 400, { error: "Icon must match the pattern ri-<name> (e.g. ri-camera-line)." });
    }
    const displayOrder = parseInt(body.displayOrder ?? 0, 10);
    const isVisible = body.visible === true || body.visible === 1 || body.visible === "true" ? 1 : 0;

    if (id) {
      const existing = db.prepare("SELECT id FROM skills WHERE id = ?").get(id);
      if (!existing) return sendJson(res, 404, { error: "Skill not found." });
      db.prepare("UPDATE skills SET name=?, percent=?, icon=?, display_order=?, is_visible=? WHERE id=?")
        .run(name, percent, icon, displayOrder, isVisible, id);
    } else {
      const newId = crypto.randomUUID();
      db.prepare("INSERT INTO skills (id, name, percent, icon, display_order, is_visible) VALUES (?,?,?,?,?,?)")
        .run(newId, name, percent, icon, displayOrder, isVisible);
    }
    return sendJson(res, 200, getSkills());
  } catch (error) {
    return sendJson(res, error.status || 500, { error: error.status ? error.message : "Could not save skill." });
  }
}

async function handlePortfolioWrite(req, res, id) {
  try {
    const contentType = req.headers["content-type"] || "";
    let body;
    let imageFile = null;
    if (contentType.toLowerCase().startsWith("multipart/form-data")) {
      const parsed = parseMultipart(await readBody(req), contentType);
      body = parsed.fields;
      imageFile = parsed.files.find((file) => file.name === "photo") || null;
    } else {
      body = await readJson(req);
    }
    const existing = id ? db.prepare("SELECT * FROM portfolio_items WHERE id = ?").get(id) : null;
    if (id && !existing) return sendJson(res, 404, { error: "Portfolio item not found." });
    if (!existing && !imageFile) return sendJson(res, 400, { error: "Choose an image file to upload." });
    if (imageFile) {
      let mimeType = (imageFile.type || "").split(";")[0].trim().toLowerCase();
      if (mimeType === "image/jpg" || mimeType === "image/pjpeg") mimeType = "image/jpeg";
      imageFile.type = mimeType;
      if (!ALLOWED_IMAGE_TYPES.has(imageFile.type)) {
        return sendJson(res, 415, { error: "Use a JPEG, PNG, WebP, or AVIF image." });
      }
      if (imageFile.data.length > MAX_UPLOAD_BYTES) return sendJson(res, 413, { error: "Image exceeds the 12 MB limit." });
      if (imageFile.data.length < 12 || !isValidImage(imageFile.data, imageFile.type)) {
        return sendJson(res, 415, { error: "The uploaded file does not match its image type." });
      }
    }
    const title = String(body.title || "").trim();
    if (!title) return sendJson(res, 400, { error: "Photo title is required." });
    const sections = new Set(parseLocations(body));
    if (boolValue(body.featured)) sections.add("featured");
    else sections.delete("featured");
    const category = String(body.category || "").trim();
    if (category && db.prepare("SELECT id FROM sections WHERE slug = ? AND is_system = 0").get(category)) {
      sections.add(category);
    }
    const oldCategory = existing?.category;
    if (oldCategory && oldCategory !== category && !sections.has(oldCategory)) {
      sections.delete(oldCategory);
    }
    if (category && db.prepare("SELECT id FROM sections WHERE slug = ? AND is_system = 0").get(category)) {
      sections.add(category);
    }
    let newMediaId = existing?.media_id || null;
    let newFileUrl = null;
    if (imageFile) {
      newMediaId = crypto.randomUUID();
      const extension = ALLOWED_IMAGE_TYPES.get(imageFile.type);
      const filename = `${crypto.randomUUID()}${extension}`;
      newFileUrl = `/uploads/${filename}`;
      fs.writeFileSync(path.join(UPLOAD_DIR, filename), imageFile.data, { flag: "wx" });
      db.prepare("INSERT INTO media (id, file_name, file_url, mime_type, alt_text) VALUES (?, ?, ?, ?, ?)")
        .run(newMediaId, imageFile.filename, newFileUrl, imageFile.type, String(body.description || "").trim());
    }
    const itemId = existing?.id || crypto.randomUUID();
    const order = Number.isFinite(Number(body.displayOrder)) ? Math.max(0, Number(body.displayOrder)) : 0;
    db.exec("BEGIN");
    try {
      if (existing) {
        db.prepare(`
          UPDATE portfolio_items SET media_id = ?, title = ?, description = ?, category = ?,
            location = ?, photo_date = ?, tags = ?, is_featured = ?, is_published = ?, is_hidden = ?,
            display_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
        `).run(
          newMediaId, title, String(body.description || "").trim(), String(body.category || "").trim(),
          String(body.location || "").trim(), String(body.photoDate || "").trim(),
          Array.isArray(body.tags) ? body.tags.join(",") : String(body.tags || "").trim(),
          boolValue(body.featured), boolValue(body.published), boolValue(body.hidden), order, itemId,
        );
      } else {
        db.prepare(`
          INSERT INTO portfolio_items
            (id, media_id, title, description, category, location, photo_date, tags, is_featured, is_published, is_hidden, display_order)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          itemId, newMediaId, title, String(body.description || "").trim(), String(body.category || "").trim(),
          String(body.location || "").trim(), String(body.photoDate || "").trim(),
          Array.isArray(body.tags) ? body.tags.join(",") : String(body.tags || "").trim(),
          boolValue(body.featured), boolValue(body.published), boolValue(body.hidden), order,
        );
      }
      saveLocations(itemId, [...sections]);
      if (newMediaId) {
        const altText = typeof body.altText === "string" ? body.altText.trim() : (typeof body.alt_text === "string" ? body.alt_text.trim() : undefined);
        let aiMetaStr = undefined;
        if (body.aiMetadata) {
          try {
            const rawObj = typeof body.aiMetadata === "string" ? JSON.parse(body.aiMetadata) : body.aiMetadata;
            aiMetaStr = JSON.stringify({
              subject: String(rawObj.subject || "").trim(),
              scene: String(rawObj.scene || "").trim(),
              mood: String(rawObj.mood || "").trim(),
              lighting: String(rawObj.lighting || "").trim(),
              composition: String(rawObj.composition || "").trim(),
              style: String(rawObj.style || "").trim(),
              analyzedAt: rawObj.analyzedAt || new Date().toISOString(),
            });
          } catch {}
        }
        if (altText !== undefined && aiMetaStr !== undefined) {
          db.prepare("UPDATE media SET alt_text = ?, ai_metadata = ? WHERE id = ?").run(altText, aiMetaStr, newMediaId);
        } else if (altText !== undefined) {
          db.prepare("UPDATE media SET alt_text = ? WHERE id = ?").run(altText, newMediaId);
        } else if (aiMetaStr !== undefined) {
          db.prepare("UPDATE media SET ai_metadata = ? WHERE id = ?").run(aiMetaStr, newMediaId);
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      if (newFileUrl) {
        db.prepare("DELETE FROM media WHERE id = ?").run(newMediaId);
        deleteOwnedFile(newFileUrl);
      }
      throw error;
    }
    if (existing && imageFile && existing.media_id !== newMediaId) cleanupUnusedMedia(existing.media_id);
    return sendJson(res, existing ? 200 : 201, getPortfolioItem(itemId));
  } catch (error) {
    return sendJson(res, error.status || 500, { error: error.status ? error.message : "Could not save portfolio item." });
  }
}

function isValidImage(data, type) {
  if (!data || data.length < 12) return false;
  let normType = (type || "").split(";")[0].trim().toLowerCase();
  if (normType === "image/jpg" || normType === "image/pjpeg") normType = "image/jpeg";

  if (normType === "image/jpeg") {
    return data[0] === 0xff && data[1] === 0xd8;
  }
  if (normType === "image/png") {
    return data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  if (normType === "image/webp") {
    return data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP";
  }
  if (normType === "image/avif") {
    return data.toString("ascii", 4, 8) === "ftyp" && data.subarray(8, 128).toString("ascii").includes("avif");
  }
  return false;
}

function boolValue(value) {
  return value === true || value === "true" || value === "1" || value === 1 ? 1 : 0;
}

function cleanupUnusedMedia(mediaId) {
  const media = db.prepare("SELECT file_url FROM media WHERE id = ?").get(mediaId);
  const reference = db.prepare("SELECT id FROM portfolio_items WHERE media_id = ? LIMIT 1").get(mediaId);
  if (media && !reference) {
    db.prepare("DELETE FROM media WHERE id = ?").run(mediaId);
    deleteOwnedFile(media.file_url);
  }
}

function handlePortfolioDelete(res, id) {
  const row = db.prepare("SELECT media_id FROM portfolio_items WHERE id = ?").get(id);
  if (!row) return sendJson(res, 404, { error: "Portfolio item not found." });
  db.prepare("DELETE FROM portfolio_items WHERE id = ?").run(id);
  cleanupUnusedMedia(row.media_id);
  return sendJson(res, 200, { deleted: true });
}

function normalizeSlug(value) {
  return String(value || "").trim().toLowerCase()
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function handleSectionWrite(req, res, id) {
  try {
    const body = await readJson(req);
    const existing = id ? db.prepare("SELECT * FROM sections WHERE id = ?").get(id) : null;
    if (id && !existing) return sendJson(res, 404, { error: "Section not found." });
    if (existing?.is_system) return sendJson(res, 403, { error: "Built-in display locations cannot be renamed." });
    const name = String(body.name || "").trim();
    const slug = normalizeSlug(body.slug || name);
    if (!name || !slug) return sendJson(res, 400, { error: "Section name and a valid slug are required." });
    if (RESERVED_SLUGS.has(slug)) return sendJson(res, 400, { error: "That slug is reserved for a site display location." });
    const order = Math.max(0, Number(body.displayOrder) || 0);
    if (existing) {
      db.prepare("UPDATE sections SET name=?, title=?, description=?, slug=?, is_visible=?, display_order=? WHERE id=?")
        .run(name, String(body.title || name), String(body.description || ""), slug, boolValue(body.visible), order, id);
    } else {
      const sectionId = crypto.randomUUID();
      db.prepare("INSERT INTO sections (id, name, title, description, slug, is_visible, display_order) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(sectionId, name, String(body.title || name), String(body.description || ""), slug, boolValue(body.visible ?? true), order);
      id = sectionId;
    }
    return sendJson(res, existing ? 200 : 201, getSections().find((section) => section.id === id));
  } catch (error) {
    console.error("Could not save section:", error);
    const conflict = String(error.message).includes("UNIQUE constraint");
    return sendJson(res, conflict ? 409 : error.status || 500, { error: conflict ? "That section slug already exists." : error.status ? error.message : "Could not save section." });
  }
}

function handleSectionDelete(res, id) {
  const section = db.prepare("SELECT * FROM sections WHERE id = ?").get(id);
  if (!section) return sendJson(res, 404, { error: "Section not found." });
  if (section.is_system) return sendJson(res, 403, { error: "Built-in display locations cannot be deleted." });
  db.prepare("DELETE FROM sections WHERE id = ?").run(id);
  return sendJson(res, 200, { deleted: true });
}

async function handleContentWrite(req, res) {
  try {
    const body = await readJson(req);
    const save = db.prepare(`
      INSERT INTO site_content (content_key, content_value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(content_key) DO UPDATE SET content_value=excluded.content_value, updated_at=CURRENT_TIMESTAMP
    `);
    db.exec("BEGIN");
    try {
      for (const [key, value] of Object.entries(body)) {
        if (typeof value !== "string" || key.length > 120 || value.length > 10000) {
          throw Object.assign(new Error(`Invalid content value for ${key}.`), { status: 400 });
        }
        save.run(key, value);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return sendJson(res, 200, getContent());
  } catch (error) {
    return sendJson(res, error.status || 500, { error: error.status ? error.message : "Could not save site content." });
  }
}

async function handleSocialWrite(req, res, id) {
  try {
    const body = await readJson(req);
    const existing = id ? db.prepare("SELECT id FROM social_links WHERE id = ?").get(id) : null;
    if (id && !existing) return sendJson(res, 404, { error: "Social link not found." });
    const platform = String(body.platform || "").trim();
    const displayName = String(body.displayName || "").trim();
    const url = validateExternalUrl(body.url, ["https:", "mailto:", "tel:"]);
    const icon = String(body.icon || "").trim();
    if (!platform || !displayName || !icon) return sendJson(res, 400, { error: "Platform, display name, and icon are required." });
    const locations = Array.isArray(body.locations) ? [...new Set(body.locations)] : [];
    const linkId = existing?.id || crypto.randomUUID();
    if (existing) {
      db.prepare("UPDATE social_links SET platform=?, display_name=?, url=?, icon=?, is_visible=?, display_order=? WHERE id=?")
        .run(platform, displayName, url, icon, boolValue(body.visible), Math.max(0, Number(body.displayOrder) || 0), linkId);
    } else {
      db.prepare("INSERT INTO social_links (id, platform, display_name, url, icon, is_visible, display_order) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(linkId, platform, displayName, url, icon, boolValue(body.visible ?? true), Math.max(0, Number(body.displayOrder) || 0));
    }
    assignSocialLocations(linkId, locations);
    return sendJson(res, existing ? 200 : 201, getSocialLinks().find((link) => link.id === linkId));
  } catch (error) {
    return sendJson(res, error.status || 500, { error: error.status ? error.message : "Could not save social link." });
  }
}

async function handleNavigationWrite(req, res, id) {
  try {
    const body = await readJson(req);
    const existing = id ? db.prepare("SELECT id FROM navigation_items WHERE id = ?").get(id) : null;
    if (id && !existing) return sendJson(res, 404, { error: "Navigation item not found." });
    const label = String(body.label || "").trim();
    const destination = String(body.url || "").trim();
    if (!label || !destination || destination.startsWith("//") || /[\r\n]/.test(destination)) {
      return sendJson(res, 400, { error: "Navigation label and a safe URL are required." });
    }
    if (/^(javascript|data|vbscript):/i.test(destination)) {
      return sendJson(res, 400, { error: "That navigation URL scheme is not allowed." });
    }
    const itemId = existing?.id || crypto.randomUUID();
    const values = [
      label, destination, String(body.icon || ""), boolValue(body.visible ?? true),
      Math.max(0, Number(body.displayOrder) || 0), itemId,
    ];
    if (existing) {
      db.prepare("UPDATE navigation_items SET label=?, url=?, icon=?, is_visible=?, display_order=? WHERE id=?").run(...values);
    } else {
      db.prepare("INSERT INTO navigation_items (label, url, icon, is_visible, display_order, id) VALUES (?, ?, ?, ?, ?, ?)").run(...values);
    }
    return sendJson(res, existing ? 200 : 201, getNavigation().find((item) => item.id === itemId));
  } catch (error) {
    return sendJson(res, error.status || 500, { error: error.status ? error.message : "Could not save navigation item." });
  }
}

function handleMediaDelete(res, id, mode) {
  const media = db.prepare("SELECT * FROM media WHERE id = ?").get(id);
  if (!media) return sendJson(res, 404, { error: "Media item not found." });
  const usages = mediaUsage(id);
  if (mode === "remove-from-sections") {
    const itemIds = [...new Set(usages.map((usage) => usage.id))];
    for (const itemId of itemIds) {
      db.prepare("DELETE FROM portfolio_item_sections WHERE portfolio_item_id = ?").run(itemId);
      db.prepare("UPDATE portfolio_items SET is_published = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(itemId);
    }
    return sendJson(res, 200, { removedFromSections: itemIds.length });
  }
  if (mode !== "permanent") return sendJson(res, 409, { error: "Choose remove-from-sections or permanent deletion.", usage: usages });
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM portfolio_item_sections WHERE portfolio_item_id IN (SELECT id FROM portfolio_items WHERE media_id = ?)").run(id);
    db.prepare("DELETE FROM portfolio_items WHERE media_id = ?").run(id);
    db.prepare("DELETE FROM media WHERE id = ?").run(id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  deleteOwnedFile(media.file_url);
  return sendJson(res, 200, { deleted: true });
}

async function handleMediaEdit(req, res, id) {
  try {
    const media = db.prepare("SELECT id FROM media WHERE id = ?").get(id);
    if (!media) return sendJson(res, 404, { error: "Media item not found." });
    const body = await readJson(req);
    const fileName = String(body.fileName || "").trim();
    const altText = String(body.altText || "").trim();
    if (!fileName || fileName.length > 255 || /[\\/\r\n]/.test(fileName) || altText.length > 1000) {
      return sendJson(res, 400, { error: "Provide a valid display filename and alt text." });
    }
    if (typeof body.aiMetadata === "string" || body.aiMetadata === null) {
      db.prepare("UPDATE media SET file_name = ?, alt_text = ?, ai_metadata = ? WHERE id = ?")
        .run(fileName, altText, body.aiMetadata, id);
    } else {
      db.prepare("UPDATE media SET file_name = ?, alt_text = ? WHERE id = ?").run(fileName, altText, id);
    }
    return sendJson(res, 200, db.prepare("SELECT * FROM media WHERE id = ?").get(id));
  } catch (error) {
    return sendJson(res, error.status || 500, { error: error.status ? error.message : "Could not update media details." });
  }
}

async function handleAiAnalyze(req, res) {
  try {
    const session = getSession(req);
    if (!session) return sendJson(res, 401, { error: "Authentication required." });

    // 5-second per-session cooldown
    const lastAnalysis = aiAnalysisCooldowns.get(session.key) || 0;
    const elapsed = Date.now() - lastAnalysis;
    if (elapsed < 5000) {
      const wait = Math.ceil((5000 - elapsed) / 1000);
      return sendJson(res, 429, { error: `Please wait ${wait}s before analyzing again.` });
    }

    const body = await readJson(req);
    const mediaId = String(body.mediaId || "").trim();
    if (!mediaId) return sendJson(res, 400, { error: "mediaId is required." });

    const media = db.prepare("SELECT * FROM media WHERE id = ?").get(mediaId);
    if (!media) return sendJson(res, 404, { error: "Media item not found." });

    // Resolve image path on disk (never use a URL)
    let imagePath;
    const fileUrl = media.file_url;
    if (fileUrl.startsWith("/uploads/")) {
      const fileName = fileUrl.slice("/uploads/".length);
      imagePath = path.join(UPLOAD_DIR, fileName);
    } else if (fileUrl.startsWith("/assets/")) {
      const fileName = decodeURIComponent(fileUrl.slice("/assets/".length));
      imagePath = path.join(ROOT, "assets", fileName);
    } else {
      return sendJson(res, 400, { error: "Cannot resolve the image file path." });
    }

    if (!fs.existsSync(imagePath)) {
      return sendJson(res, 404, { error: "Image file not found on disk." });
    }

    aiAnalysisCooldowns.set(session.key, Date.now());
    const result = await analyzePhoto(imagePath, media.mime_type);

    return sendJson(res, 200, result);
  } catch (error) {
    return sendJson(res, error.status || 500, {
      error: error.status ? error.message : "AI analysis failed unexpectedly.",
    });
  }
}

async function handleMediaReplace(req, res, id) {
  try {
    const media = db.prepare("SELECT * FROM media WHERE id = ?").get(id);
    if (!media) return sendJson(res, 404, { error: "Media item not found." });
    const parsed = parseMultipart(await readBody(req), req.headers["content-type"] || "");
    const photo = parsed.files.find((file) => file.name === "photo");
    if (photo) {
      let mimeType = (photo.type || "").split(";")[0].trim().toLowerCase();
      if (mimeType === "image/jpg" || mimeType === "image/pjpeg") mimeType = "image/jpeg";
      photo.type = mimeType;
    }
    if (!photo || !ALLOWED_IMAGE_TYPES.has(photo?.type) || !isValidImage(photo.data, photo.type)) {
      return sendJson(res, 415, { error: "Upload a valid JPEG, PNG, WebP, or AVIF image." });
    }
    if (photo.data.length > MAX_UPLOAD_BYTES) return sendJson(res, 413, { error: "Image exceeds the 12 MB limit." });
    const extension = ALLOWED_IMAGE_TYPES.get(photo.type);
    const fileName = `${crypto.randomUUID()}${extension}`;
    const fileUrl = `/uploads/${fileName}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, fileName), photo.data, { flag: "wx" });
    db.prepare("UPDATE media SET file_name=?, file_url=?, mime_type=? WHERE id=?")
      .run(photo.filename, fileUrl, photo.type, id);
    deleteOwnedFile(media.file_url);
    return sendJson(res, 200, { id, fileName: photo.filename, fileUrl, mimeType: photo.type });
  } catch (error) {
    return sendJson(res, error.status || 500, { error: error.status ? error.message : "Could not replace media file." });
  }
}

function serveStatic(req, res, url) {
  const pathname = decodeURIComponent(url.pathname);
  const cleanPath = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const adminRoutes = new Set([
    "/admin", "/admin/login", "/admin/dashboard", "/admin/portfolio",
    "/admin/content", "/admin/skills", "/admin/social",
    "/admin/navigation", "/admin/media", "/admin/settings",
  ]);
  if (adminRoutes.has(cleanPath)) {
    const file = fs.readFileSync(path.join(ROOT, "admin", "admin.html"));
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; font-src 'self' https://cdn.jsdelivr.net https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    });
    return res.end(file);
  }
  const aliases = { "/about": "about.html", "/portfolio": "photography.html", "/contact": "hire.html" };
  const relative = pathname === "/" ? "home.html" : aliases[pathname] || pathname.slice(1);
  const firstPathSegment = relative.split(/[\\/]/, 1)[0].toLowerCase();
  if (
    firstPathSegment === ".git" ||
    firstPathSegment === "data" ||
    firstPathSegment === "node_modules" ||
    relative.toLowerCase() === ".env" ||
    relative.toLowerCase() === "javascript/server.js"
  ) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Not found");
  }
  const base = relative.startsWith("uploads/") ? UPLOAD_DIR : ROOT;
  const target = path.resolve(base, relative.startsWith("uploads/") ? relative.slice("uploads/".length) : relative);
  const allowedRoot = relative.startsWith("uploads/") ? UPLOAD_DIR : ROOT;
  if (!target.startsWith(`${allowedRoot}${path.sep}`) && target !== allowedRoot) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Not found");
  }
  const type = MIME_BY_EXTENSION.get(path.extname(target).toLowerCase()) || "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": type,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": type.startsWith("image/") ? "public, max-age=86400" : "no-cache",
    ...(relative.startsWith("uploads/") ? { "Content-Disposition": "inline" } : {}),
  });
  return fs.createReadStream(target).pipe(res);
}

async function requestHandler(req, res) {
  const rawPath = req.headers["x-forwarded-uri"] || req.headers["x-matched-path"] || req.url;
  const url = new URL(rawPath, `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && url.pathname === "/api/public/site") {
    const sections = getSections().filter((section) => section.visible);
    const items = getPortfolioItems({ publicOnly: true });
    const photos = {};
    for (const section of sections) {
      photos[section.slug] = items.filter((item) => item.sections.includes(section.slug));
    }
    const socialLinks = getSocialLinks().filter((link) => link.visible);
    return sendJson(res, 200, {
      content: getContent(),
      navigation: getNavigation().filter((item) => item.visible),
      sections,
      photos,
      socialLinks,
      skills: getSkills({ visibleOnly: true }),
    });
  }
  if (url.pathname.startsWith("/api/") && req.method !== "GET" && !checkOrigin(req, res)) return;
  const handled = handleAdminApi(req, res, url);
  if (handled) return;
  if (url.pathname.startsWith("/api/")) return sendJson(res, 404, { error: "API route not found." });
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    return res.end("Method not allowed");
  }
  return serveStatic(req, res, url);
}

const server = http.createServer((req, res) => {
  requestHandler(req, res).catch((error) => {
    console.error(error);
    if (!res.headersSent) sendJson(res, error.status || 500, { error: "The server could not complete the request." });
    else res.destroy();
  });
});

if (!IS_VERCEL && require.main === module) {
  server.listen(PORT, () => {
    console.log(`Photography portfolio CMS running at http://localhost:${PORT}`);
  });
}

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

module.exports = { requestHandler, server };
