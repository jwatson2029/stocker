#!/usr/bin/env node
/**
 * Continuous 24/7 HLS recorder → Supabase Storage.
 *
 * Requires ffmpeg on PATH. Keeps recording in segment files, uploads each
 * finished segment, then starts the next (refreshing the signed stream URL).
 *
 * Usage: npm run record:24x7
 * Env:   RECORD_SEGMENT_SECS (default 600 = 10 min)
 */
require("dotenv").config();

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { getSignedVideoUrl, CAMERA_ID, IMAGE_ID } = require("../lib/ga511");
const { getServiceClient, BUCKET } = require("../lib/supabase");

const SEGMENT_SECS = Math.max(
  60,
  Number(process.env.RECORD_SEGMENT_SECS || 600)
);
const TMP_DIR = path.join(os.tmpdir(), "stocker-record");
const RETRY_MS = 5000;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ensureTmp() {
  fs.mkdirSync(TMP_DIR, { recursive: true });
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
    let err = "";
    child.stderr.on("data", (d) => {
      err += d.toString();
    });
    child.on("error", (e) => {
      reject(
        new Error(
          `ffmpeg failed to start (${e.message}). Install ffmpeg and ensure it is on PATH.`
        )
      );
    });
    child.on("close", (code) => {
      if (code === 0 && fs.existsSync(outFile) && fs.statSync(outFile).size > 0) {
        resolve();
      } else {
        reject(new Error(err.trim() || `ffmpeg exited ${code}`));
      }
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
  log(
    `24/7 recorder starting (camera ${CAMERA_ID}, view ${IMAGE_ID}, segment ${SEGMENT_SECS}s)`
  );
  // Touch Supabase once so WebSocket/config errors surface immediately.
  getServiceClient();

  for (;;) {
    try {
      await recordOneSegment();
    } catch (err) {
      log("Segment failed:", err.message || err);
      await sleep(RETRY_MS);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
