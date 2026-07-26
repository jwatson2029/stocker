#!/usr/bin/env node
/**
 * Daytime HLS recorder → Supabase Storage.
 *
 * Requires ffmpeg on PATH. Records fixed-length segments, uploads each one,
 * then deletes recordings older than the retention window (default 24h).
 *
 * Quiet hours (default America/New_York): pauses 8:00 PM–6:00 AM,
 * resumes at 6:01 AM.
 *
 * Usage: npm run record:24x7
 *        Docker / Render worker: see Dockerfile + render.yaml
 * Env:   RECORD_SEGMENT_SECS (default 60)
 *        RECORD_RETENTION_HOURS (default 24)
 *        RECORD_TZ (default America/New_York)
 *        RECORD_QUIET_START (default 20:00)  — stop recording at this time
 *        RECORD_QUIET_END (default 06:01)    — resume recording at this time
 */
require("dotenv").config();

const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { getSignedVideoUrl, CAMERA_ID, IMAGE_ID } = require("../lib/ga511");
const { getServiceClient, BUCKET } = require("../lib/supabase");
const { deleteOlderThan } = require("../lib/recordings");

const SEGMENT_SECS = Math.max(
  10,
  Number(process.env.RECORD_SEGMENT_SECS || 60)
);
const RETENTION_HOURS = Math.max(
  1,
  Number(process.env.RECORD_RETENTION_HOURS || 24)
);
const TMP_DIR = path.join(os.tmpdir(), "stocker-record");
const RETRY_MS = 5000;
const QUIET_POLL_MS = 30_000;
const PORT = Number(process.env.PORT || 0);
/** How often to purge clips older than RECORD_RETENTION_HOURS (default 1h). */
const PRUNE_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.RECORD_PRUNE_INTERVAL_MS || 60 * 60 * 1000)
);
const RECORD_TZ = process.env.RECORD_TZ || "America/New_York";
const QUIET_START = parseHm(process.env.RECORD_QUIET_START || "20:00");
const QUIET_END = parseHm(process.env.RECORD_QUIET_END || "06:01");

/** @type {import("child_process").ChildProcess | null} */
let activeFfmpeg = null;
let shuttingDown = false;
let lastSegmentAt = null;
let lastError = null;
let lastPruneAt = null;
let segmentsUploaded = 0;
let inQuietHours = false;
/** @type {import("http").Server | null} */
let healthServer = null;
/** @type {ReturnType<typeof setInterval> | null} */
let pruneTimer = null;

function parseHm(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim());
  if (!m) throw new Error(`Invalid HH:MM time: ${value}`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) throw new Error(`Invalid HH:MM time: ${value}`);
  return hour * 60 + minute;
}

function formatHm(mins) {
  const h = String(Math.floor(mins / 60) % 24).padStart(2, "0");
  const m = String(mins % 60).padStart(2, "0");
  return `${h}:${m}`;
}

function getLocalMinutes(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: RECORD_TZ,
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === "hour")?.value || 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value || 0);
  return hour * 60 + minute;
}

/**
 * Quiet window may wrap midnight (e.g. 20:00 → 06:01).
 * Recording is off while local time is inside [start, end).
 */
function isQuietHours(date = new Date()) {
  const now = getLocalMinutes(date);
  if (QUIET_START === QUIET_END) return false;
  if (QUIET_START < QUIET_END) {
    return now >= QUIET_START && now < QUIET_END;
  }
  return now >= QUIET_START || now < QUIET_END;
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ensureTmp() {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

async function waitUntilRecordingWindow() {
  if (!isQuietHours()) {
    if (inQuietHours) {
      inQuietHours = false;
      log(`Quiet hours ended (${RECORD_TZ}) — recording resumes`);
    }
    return;
  }

  if (!inQuietHours) {
    inQuietHours = true;
    log(
      `Quiet hours ${formatHm(QUIET_START)}–${formatHm(QUIET_END)} ${RECORD_TZ} — pausing recording`
    );
  }

  while (!shuttingDown && isQuietHours()) {
    await sleep(QUIET_POLL_MS);
  }

  if (!shuttingDown) {
    inQuietHours = false;
    log(`Quiet hours over — resuming recording (${RECORD_TZ})`);
  }
}

function runFfmpeg(url, outFile, seconds) {
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-rw_timeout",
      "15000000",
      "-i",
      url,
      "-t",
      String(seconds),
      "-c",
      "copy",
      "-bsf:a",
      "aac_adtstoasc",
      "-movflags",
      "+faststart",
      outFile,
    ];
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    activeFfmpeg = child;
    let err = "";
    child.stderr.on("data", (d) => {
      err += d.toString();
    });
    child.on("error", (e) => {
      if (activeFfmpeg === child) activeFfmpeg = null;
      reject(
        new Error(
          `ffmpeg failed to start (${e.message}). Install ffmpeg and ensure it is on PATH.`
        )
      );
    });
    child.on("close", (code) => {
      if (activeFfmpeg === child) activeFfmpeg = null;
      if (shuttingDown) {
        reject(new Error("shutdown"));
        return;
      }
      if (code === 0 && fs.existsSync(outFile) && fs.statSync(outFile).size > 0) {
        resolve();
      } else {
        reject(new Error(err.trim() || `ffmpeg exited ${code}`));
      }
    });
  });
}

function requestShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Received ${signal}, shutting down…`);
  if (activeFfmpeg && !activeFfmpeg.killed) {
    try {
      activeFfmpeg.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  if (healthServer) {
    healthServer.close();
  }
}

/**
 * Render web services require binding $PORT before deploy is marked live.
 * Start a tiny health server first, then run the recorder loop.
 */
function listenHealthServer() {
  if (!PORT) return Promise.resolve();

  return new Promise((resolve, reject) => {
    healthServer = http.createServer((req, res) => {
      const url = req.url || "/";
      if (url === "/healthz" || url === "/" || url === "/health") {
        const quiet = isQuietHours();
        const body = JSON.stringify({
          ok: true,
          service: "stocker-recorder",
          cameraId: CAMERA_ID,
          imageId: IMAGE_ID,
          segmentSecs: SEGMENT_SECS,
          retentionHours: RETENTION_HOURS,
          timezone: RECORD_TZ,
          quietHours: {
            start: formatHm(QUIET_START),
            end: formatHm(QUIET_END),
            active: quiet,
          },
          segmentsUploaded,
          lastSegmentAt,
          lastPruneAt,
          lastError,
          recording: !shuttingDown && !quiet,
        });
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(body);
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    });

    healthServer.once("error", reject);
    healthServer.listen(PORT, "0.0.0.0", () => {
      log(`Health server listening on 0.0.0.0:${PORT}`);
      resolve();
    });
  });
}

async function uploadSegment(filePath, durationMs) {
  const supabase = getServiceClient();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `FORS-0021_${stamp}_24x7.mp4`;
  const storagePath = `${CAMERA_ID || "camera"}/${stamp}_${filename}`;
  const body = fs.readFileSync(filePath);
  const size = body.length;

  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, body, {
      contentType: "video/mp4",
      upsert: false,
    });
  if (upErr) throw upErr;

  const { data, error: metaErr } = await supabase
    .from("recordings")
    .insert({
      filename,
      storage_path: storagePath,
      content_type: "video/mp4",
      size_bytes: size,
      camera_id: String(CAMERA_ID),
      duration_ms: durationMs,
    })
    .select("id, filename")
    .single();
  if (metaErr) throw metaErr;

  return { id: data.id, filename: data.filename, size, path: storagePath };
}

async function pruneOldRecordings() {
  const result = await deleteOlderThan({ hours: RETENTION_HOURS });
  lastPruneAt = new Date().toISOString();
  if (result.deleted > 0) {
    log(
      `Pruned ${result.deleted} recording(s) older than ${RETENTION_HOURS}h (before ${result.cutoff})`
    );
  } else {
    log(`Retention check OK — nothing older than ${RETENTION_HOURS}h`);
  }
  return result;
}

async function recordOneSegment() {
  ensureTmp();
  const url = await getSignedVideoUrl(IMAGE_ID);
  const outFile = path.join(TMP_DIR, `seg_${Date.now()}.mp4`);
  const started = Date.now();
  log(`Recording ${SEGMENT_SECS}s segment…`);
  try {
    await runFfmpeg(url, outFile, SEGMENT_SECS);
    const durationMs = Date.now() - started;
    const saved = await uploadSegment(outFile, durationMs);
    segmentsUploaded += 1;
    lastSegmentAt = new Date().toISOString();
    lastError = null;
    log(`Uploaded ${saved.filename} (${saved.size} bytes) → ${saved.path}`);
    return saved;
  } finally {
    try {
      fs.unlinkSync(outFile);
    } catch {
      /* ignore */
    }
  }
}

async function main() {
  process.on("SIGTERM", () => requestShutdown("SIGTERM"));
  process.on("SIGINT", () => requestShutdown("SIGINT"));

  // Bind PORT first so Render marks the deploy as live, then record.
  await listenHealthServer();

  log(
    `Recorder starting (camera ${CAMERA_ID}, view ${IMAGE_ID}, segment ${SEGMENT_SECS}s, retain ${RETENTION_HOURS}h, prune every ${Math.round(PRUNE_INTERVAL_MS / 60000)}m, quiet ${formatHm(QUIET_START)}–${formatHm(QUIET_END)} ${RECORD_TZ})`
  );
  getServiceClient();
  await pruneOldRecordings();
  pruneTimer = setInterval(() => {
    pruneOldRecordings().catch((err) => {
      log("Prune failed:", err.message || err);
    });
  }, PRUNE_INTERVAL_MS);
  if (typeof pruneTimer.unref === "function") pruneTimer.unref();

  while (!shuttingDown) {
    try {
      await waitUntilRecordingWindow();
      if (shuttingDown) break;
      await recordOneSegment();
    } catch (err) {
      if (shuttingDown) break;
      lastError = String(err.message || err);
      log("Segment failed:", err.message || err);
      await sleep(RETRY_MS);
    }
  }

  if (pruneTimer) clearInterval(pruneTimer);
  log("Recorder stopped.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
