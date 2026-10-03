const { requestHandler } = require("./server-supabase.js");

async function handler(req, res) {
  try {
    await requestHandler(req, res);
  } catch (error) {
    console.error("Vercel Serverless Handler Error:", error);
    if (!res.headersSent) {
      res.statusCode = error.status || 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: error.status ? error.message : "Internal Server Error" }));
    }
  }
}

module.exports = handler;
