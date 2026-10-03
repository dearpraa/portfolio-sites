const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const checks = [];
const pass = (name) => checks.push({ name, ok: true });
const fail = (name, detail) => checks.push({ name, ok: false, detail });

function read(relative) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

function exists(relative) {
  return fs.existsSync(path.join(root, relative));
}

function includes(text, value, name) {
  text.includes(value) ? pass(name) : fail(name, "missing: " + value);
}

function excludes(text, value, name) {
  text.includes(value) ? fail(name, "unexpected: " + value) : pass(name);
}

const shared = read("admin/shared.html");
const content = read("admin/content.html");
const skills = read("admin/skills.html");
const portfolio = read("admin/portfolio.html");
const adminJs = read("Javascript/admin.js");
const server = read("Javascript/server.js");
const vercel = read("vercel.json");

[
  "admin/login.html",
  "admin/dashboard.html",
  "admin/admin.html",
  "admin/social.html",
  "admin/navigation.html",
  "admin/media.html",
  "admin/settings.html",
].forEach((file) => exists(file) ? pass("file exists: " + file) : fail("file missing: " + file));

[
  "admin/gallery.html",
  "admin/sections.html",
].forEach((file) => !exists(file) ? pass("removed obsolete file: " + file) : fail("obsolete file still exists: " + file));

["dashboard","portfolio","content","skills","social","navigation","media","settings"]
  .forEach((route) => includes(shared, 'data-route="' + route + '"', "sidebar: " + route));

["gallery","sections"].forEach((route) => excludes(shared, 'data-route="' + route + '"', "sidebar removed: " + route));

[
  "home","about","portfolio","contact","footer"
].forEach((section) => includes(content, 'data-content-save="' + section + '"', "content save: " + section));

excludes(content, "Skills &amp; Expertise", "skills removed from content page");
includes(skills, 'id="skill-rows"', "skills page rows");
includes(skills, 'data-action="add-skill"', "skills page add button");
includes(portfolio, 'id="photo-rows"', "portfolio rows");
excludes(portfolio, 'id="photo-section"', "portfolio section filter removed");
excludes(shared, 'data-photo-sections', "photo section assignments removed");
excludes(shared, 'section-dialog-form-template', "section dialog removed");

[
  "async function contentPage()",
  "function renderSkills(",
  "async function skillDialog(",
  "async function skillsPage()",
].forEach((value) => includes(adminJs, value, "admin.js: " + value));

excludes(adminJs, "galleryOnly", "admin.js gallery mode removed");
excludes(adminJs, "sectionPage", "admin.js section page removed");
excludes(adminJs, "add-section", "admin.js section action removed");
includes(adminJs, "data-content-save", "admin.js content save handler");
includes(adminJs, 'skills: skillsPage', "admin.js skills route");

excludes(server, '"/admin/gallery"', "server gallery route removed");
excludes(server, '"/admin/sections"', "server sections page route removed");
includes(server, '"/admin/skills"', "server skills route enabled");
includes(vercel, '"/admin/skills"', "vercel skills route enabled");
excludes(vercel, '"/admin/gallery"', "vercel gallery route removed");
excludes(vercel, '"/admin/sections"', "vercel sections route removed");

try {
  new vm.Script(adminJs, { filename: "Javascript/admin.js" });
  pass("admin.js syntax");
} catch (error) {
  fail("admin.js syntax", error.message);
}

const failures = checks.filter((item) => !item.ok);
console.log(JSON.stringify({
  passed: checks.length - failures.length,
  failed: failures.length,
  failures,
}, null, 2));

process.exitCode = failures.length ? 1 : 0;
