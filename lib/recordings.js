const { getServiceClient, publicObjectUrl, BUCKET } = require("../lib/supabase");

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body && typeof req.body === "object") {
      resolve(req.body);
      return;
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.end(JSON.stringify(data));
}

function safeFilename(name) {
  const base = String(name || "recording.webm").replace(/[^a-zA-Z0-9._-]/g, "_");
  return base.slice(0, 180) || "recording.webm";
}

async function listRecordings() {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("recordings")
    .select("id, filename, storage_path, content_type, size_bytes, camera_id, duration_ms, created_at")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data || []).map((row) => ({
    id: row.id,
    name: row.filename,
    path: row.storage_path,
    size: Number(row.size_bytes || 0),
    contentType: row.content_type,
    cameraId: row.camera_id,
    durationMs: row.duration_ms,
    mtime: row.created_at,
    url: publicObjectUrl(row.storage_path),
  }));
}

async function prepareUpload({ filename, contentType, cameraId }) {
  const supabase = getServiceClient();
  const safe = safeFilename(filename);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = `${cameraId || "camera"}/${stamp}_${safe}`;

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUploadUrl(path);
  if (error) throw error;

  return {
    path: data.path || path,
    token: data.token,
    signedUrl: data.signedUrl,
    contentType: contentType || "video/webm",
  };
}

async function confirmUpload({
  path,
  filename,
  contentType,
  size,
  cameraId,
  durationMs,
}) {
  if (!path || !filename) throw new Error("path and filename are required");
  const supabase = getServiceClient();
  const row = {
    filename: safeFilename(filename),
    storage_path: path,
    content_type: contentType || "video/webm",
    size_bytes: Number(size || 0),
    camera_id: cameraId || null,
    duration_ms: durationMs != null ? Number(durationMs) : null,
  };
  const { data, error } = await supabase
    .from("recordings")
    .insert(row)
    .select("id, filename, storage_path, content_type, size_bytes, camera_id, duration_ms, created_at")
    .single();
  if (error) throw error;
  return {
    id: data.id,
    name: data.filename,
    path: data.storage_path,
    size: Number(data.size_bytes || 0),
    contentType: data.content_type,
    cameraId: data.camera_id,
    durationMs: data.duration_ms,
    mtime: data.created_at,
    url: publicObjectUrl(data.storage_path),
  };
}

async function deleteRecording(id) {
  if (!id) throw new Error("id is required");
  const supabase = getServiceClient();
  const { data: row, error: findErr } = await supabase
    .from("recordings")
    .select("id, storage_path")
    .eq("id", id)
    .maybeSingle();
  if (findErr) throw findErr;
  if (!row) throw new Error("Recording not found");

  const { error: storageErr } = await supabase.storage
    .from(BUCKET)
    .remove([row.storage_path]);
  if (storageErr) throw storageErr;

  const { error: delErr } = await supabase.from("recordings").delete().eq("id", id);
  if (delErr) throw delErr;
  return { deleted: id };
}

/** Delete recordings (storage + rows) older than the given age. */
async function deleteOlderThan({ hours = 24 } = {}) {
  const supabase = getServiceClient();
  const cutoff = new Date(Date.now() - Math.max(1, hours) * 60 * 60 * 1000).toISOString();
  const { data: rows, error: findErr } = await supabase
    .from("recordings")
    .select("id, storage_path")
    .lt("created_at", cutoff)
    .limit(500);
  if (findErr) throw findErr;
  if (!rows || !rows.length) return { deleted: 0, cutoff };

  const paths = rows.map((r) => r.storage_path).filter(Boolean);
  if (paths.length) {
    const { error: storageErr } = await supabase.storage.from(BUCKET).remove(paths);
    if (storageErr) throw storageErr;
  }

  const ids = rows.map((r) => r.id);
  const { error: delErr } = await supabase.from("recordings").delete().in("id", ids);
  if (delErr) throw delErr;
  return { deleted: ids.length, cutoff };
}

async function handleRecordingsApi(req, res, action) {
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  try {
    if (action === "list" && req.method === "GET") {
      sendJson(res, 200, { recordings: await listRecordings() });
      return;
    }

    if (action === "prepare" && req.method === "POST") {
      const body = await readJsonBody(req);
      sendJson(res, 200, await prepareUpload(body));
      return;
    }

    if (action === "confirm" && req.method === "POST") {
      const body = await readJsonBody(req);
      sendJson(res, 200, await confirmUpload(body));
      return;
    }

    if (action === "delete" && req.method === "DELETE") {
      const url = new URL(req.url, "http://localhost");
      const id = url.searchParams.get("id") || (req.query && req.query.id);
      sendJson(res, 200, await deleteRecording(id));
      return;
    }

    sendJson(res, 405, { error: "Method not allowed" });
  } catch (err) {
    console.error(err);
    sendJson(res, 502, { error: err.message || String(err) });
  }
}

module.exports = {
  handleRecordingsApi,
  listRecordings,
  prepareUpload,
  confirmUpload,
  deleteRecording,
  deleteOlderThan,
  readJsonBody,
  sendJson,
};
