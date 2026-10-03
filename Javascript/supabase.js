const { createClient } = require("@supabase/supabase-js");

let client;

function getSupabase() {
  if (client) return client;

  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secretKey || /your_actual_secret_key|replace-with/i.test(secretKey)) {
    throw new Error(
      "Set SUPABASE_URL and a real SUPABASE_SECRET_KEY in the server environment.",
    );
  }

  client = createClient(url, secretKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
  return client;
}

async function dataFrom(query) {
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

module.exports = { dataFrom, getSupabase };
