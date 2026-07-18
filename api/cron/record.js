/**
 * Vercel Cron / manual serverless record action.
 * Captures a short live HLS clip and uploads it to Supabase.
 *
 * Auth: Authorization: Bearer $CRON_SECRET
 * (Vercel Cron sends this automatically when CRON_SECRET is set.)
 *
 * Query/body: durationSecs (default 45, max 120)
 */
require("dotenv").config();

const { captureHlsClip, uploadClipBuffer } = require("../../lib/hls-capture");

function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

function authorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // allow if unset (local/dev); set CRON_SECRET in Vercel
  const header = req.headers.authorization || "";
  return header === `Bearer ${secret}`;
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== "GET" && req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  if (!authorized(req)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }

  const url = new URL(req.url || "/", "http://localhost");
  const rawDur =
    url.searchParams.get("durationSecs") ||
    (req.body && req.body.durationSecs) ||
    process.env.CRON_RECORD_SECS ||
    45;
  const durationSecs = Math.min(120, Math.max(10, Number(rawDur) || 45));
  // Leave headroom under Vercel maxDuration (300s hobby / configurable).
  const maxWaitMs = Math.min(250_000, durationSecs * 1000 + 30_000);

  try {
    const clip = await captureHlsClip({ durationSecs, maxWaitMs });
    const saved = await uploadClipBuffer({
      buffer: clip.buffer,
      contentType: clip.contentType,
      extension: clip.extension,
      durationMs: clip.durationMs,
      source: "cron",
    });
    sendJson(res, 200, {
      ok: true,
      recording: saved,
      segments: clip.segmentCount,
    });
  } catch (err) {
    console.error("cron/record failed", err);
    sendJson(res, 502, { error: err.message || String(err) });
  }
};
