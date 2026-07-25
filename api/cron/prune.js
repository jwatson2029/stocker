/**
 * Vercel Cron: delete Supabase recordings older than RECORD_RETENTION_HOURS (default 24).
 *
 * Auth: Authorization: Bearer $CRON_SECRET
 */
require("dotenv").config();

const { deleteOlderThan } = require("../../lib/recordings");

function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

function authorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
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

  const retentionHours = Math.max(
    1,
    Number(process.env.RECORD_RETENTION_HOURS || 24)
  );

  try {
    const pruned = await deleteOlderThan({ hours: retentionHours });
    sendJson(res, 200, {
      ok: true,
      retentionHours,
      deleted: pruned.deleted,
      cutoff: pruned.cutoff,
    });
  } catch (err) {
    console.error("cron/prune failed", err);
    sendJson(res, 502, { error: err.message || String(err) });
  }
};
