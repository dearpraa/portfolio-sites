/**
 * AI Photo Analysis Service
 *
 * Sends a photo from disk to the Gemini API for metadata extraction.
 * The API key is always sent in the x-goog-api-key header, never in
 * the URL or error messages.  Configuration comes from environment
 * variables: AI_PROVIDER, AI_API_KEY, AI_MODEL.
 */

const fs = require("node:fs");

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const ANALYSIS_PROMPT = `You are a photography metadata assistant. Analyze this photograph and return a JSON object with exactly these fields:

- "title": A short, descriptive title for the photograph (2–6 words). Required.
- "description": A brief description of what the photograph shows (1–3 sentences). Required.
- "altText": Descriptive accessibility text for screen readers (1 sentence focusing purely on visual content). Required.
- "category": A single lowercase category slug. Choose from: nature, portrait, street, landscape, urban, travel, monochrome, architecture. If uncertain, use "".
- "tags": An array of up to 8 relevant lowercase keyword tags.
- "location": The geographic location depicted, if clearly identifiable (e.g. "Pokhara, Nepal"). If you are NOT highly confident about the specific place, you MUST leave this field as an empty string "".
- "subject": Main subject depicted (e.g. "snowy mountain peak").
- "scene": Setting or environment (e.g. "alpine wilderness at dawn").
- "mood": Overall emotional tone or feeling (e.g. "serene, majestic").
- "lighting": Lighting conditions (e.g. "soft golden hour sunlight").
- "composition": Framing and photographic composition technique (e.g. "rule of thirds, wide angle").
- "style": Visual or artistic style (e.g. "fine art landscape photography").

CRITICAL RULES:
1. Return ONLY a single valid JSON object. No markdown fences, no extra text before or after.
2. Do NOT include any date or photoDate field. NEVER attempt to guess dates.
3. If you are uncertain about ANY field (especially location), leave it as an empty string ("" for strings, [] for tags).
4. Do NOT fabricate, hallucinate, or invent information.
5. Keep descriptions factual and concise.`;

/**
 * Validate and sanitize the raw AI response into a strict schema.
 * Returns null if the result is completely unusable.
 */
function validateAnalysisResult(result) {
  if (typeof result !== "object" || result === null) return null;

  const str = (v, maxLen = 200) => (typeof v === "string" ? v.trim().slice(0, maxLen) : "");

  const validated = {
    title: str(result.title, 200),
    description: str(result.description, 1000),
    altText: str(result.altText, 500),
    category: str(result.category, 50).toLowerCase().replace(/[^a-z0-9-]/g, ""),
    location: str(result.location, 200),
    subject: str(result.subject, 200),
    scene: str(result.scene, 200),
    mood: str(result.mood, 200),
    lighting: str(result.lighting, 200),
    composition: str(result.composition, 200),
    style: str(result.style, 200),
    tags: [],
  };

  if (Array.isArray(result.tags)) {
    validated.tags = result.tags
      .filter((tag) => typeof tag === "string")
      .map((tag) => tag.trim().toLowerCase().replace(/[^a-z0-9 -]/g, ""))
      .filter(Boolean)
      .slice(0, 8);
  }

  // Must have at least a title or description to be useful
  if (!validated.title && !validated.description) return null;

  return validated;
}

/**
 * Analyze a photo using the configured AI provider.
 *
 * @param {string} imagePath  Absolute path to the image file on disk.
 * @param {string} mimeType   MIME type of the image (e.g. "image/jpeg").
 * @returns {Promise<object>} Validated analysis result.
 */
async function analyzePhoto(imagePath, mimeType) {
  const apiKey = process.env.AI_API_KEY;
  if (!apiKey) {
    throw Object.assign(new Error("AI analysis is not configured. Set AI_API_KEY in .env."), { status: 503 });
  }

  const provider = (process.env.AI_PROVIDER || "gemini").toLowerCase();
  if (provider !== "gemini") {
    throw Object.assign(new Error("Only the Gemini AI provider is currently supported."), { status: 400 });
  }

  const model = process.env.AI_MODEL || "gemini-flash-latest";

  // Read image from disk (never from a URL)
  if (!fs.existsSync(imagePath)) {
    throw Object.assign(new Error("Image file not found on disk."), { status: 404 });
  }
  const imageBuffer = fs.readFileSync(imagePath);
  const base64Image = imageBuffer.toString("base64");

  // Build the API URL — the key is NEVER included here
  const url = `${GEMINI_API_BASE}/${encodeURIComponent(model)}:generateContent`;

  const requestBody = {
    contents: [{
      parts: [
        { text: ANALYSIS_PROMPT },
        { inline_data: { mime_type: mimeType, data: base64Image } },
      ],
    }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 1024,
    },
  };

  // 30-second timeout
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,          // Key sent ONLY as a header
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw Object.assign(new Error("AI analysis timed out after 30 seconds."), { status: 504 });
    }
    // Never include the request URL in the error message
    throw Object.assign(new Error("Could not reach the AI service."), { status: 502 });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    // Extract a safe error detail without leaking request info
    const httpStatus = response.status;
    let detail = "";
    try {
      const errorBody = await response.json();
      detail = errorBody?.error?.message || "";
    } catch { /* ignore parse errors */ }
    throw Object.assign(
      new Error(`AI service error (HTTP ${httpStatus}).${detail ? " " + detail : ""}`),
      { status: httpStatus >= 500 ? 502 : 400 },
    );
  }

  const responseData = await response.json();
  const textContent = responseData?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!textContent) {
    throw Object.assign(new Error("AI service returned an empty response."), { status: 502 });
  }

  // Strip markdown code fences if present
  const cleaned = textContent
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw Object.assign(new Error("AI service returned invalid JSON."), { status: 502 });
  }

  const validated = validateAnalysisResult(parsed);
  if (!validated) {
    throw Object.assign(new Error("AI analysis produced unusable results. Try again with a different photo."), { status: 422 });
  }

  return validated;
}

module.exports = { analyzePhoto, validateAnalysisResult };
