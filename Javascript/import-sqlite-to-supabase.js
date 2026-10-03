try {
  if (typeof process.loadEnvFile === "function") process.loadEnvFile();
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { dataFrom, getSupabase } = require("./supabase.js");

const root = path.resolve(__dirname, "..");
const databasePath = process.env.DB_PATH || path.join(root, "data", "portfolio.sqlite");
const tableOrder = [
  ["sections", "id"],
  ["media", "id"],
  ["social_links", "id"],
  ["navigation_items", "id"],
  ["skills", "id"],
  ["site_content", "content_key"],
  ["portfolio_items", "id"],
  ["social_link_locations", "social_link_id,location"],
  ["portfolio_item_sections", "portfolio_item_id,section_id"],
];

async function importRows(sqlite, supabase, table, conflictColumns) {
  const rows = sqlite.prepare(`SELECT * FROM "${table}"`).all().map((row) => ({ ...row }));

  for (let offset = 0; offset < rows.length; offset += 500) {
    await dataFrom(
      supabase
        .from(table)
        .upsert(rows.slice(offset, offset + 500), { onConflict: conflictColumns }),
    );
  }
  console.log(`Imported ${rows.length} row(s) into ${table}.`);
}

async function main() {
  const sqlite = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const supabase = getSupabase();
    for (const [table, conflictColumns] of tableOrder) {
      await importRows(sqlite, supabase, table, conflictColumns);
    }
    console.log("SQLite CMS data import completed.");
  } finally {
    sqlite.close();
  }
}

main().catch((error) => {
  console.error("SQLite-to-Supabase import failed:", error);
  process.exitCode = 1;
});
