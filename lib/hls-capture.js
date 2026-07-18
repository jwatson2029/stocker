const { getSignedVideoUrl, CAMERA_ID, IMAGE_ID } = require("./ga511");
const { getServiceClient, BUCKET } = require("./supabase");

const UA = "stocker/1.0";

function resolveUrl(base, maybeRelative) {
  try {
    return new URL(maybeRelative, base).href;
  } catch {
    return maybeRelative;
  }
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "*/*" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching playlist`);
  return { text: await res.text(), finalUrl: res.url || url };
}

function parseM3u8(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const variants = [];
  const segments = [];
  let targetDuration = 6;
  let pendingBandwidth = null;
  let pendingResolution = null;

  for (const line of lines) {
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const bw = /BANDWIDTH=(\d+)/i.exec(line);
      const res = /RESOLUTION=(\d+)x(\d+)/i.exec(line);
      pendingBandwidth = bw ? Number(bw[1]) : 0;
      pendingResolution = res
        ? Number(res[1]) * Number(res[2])
        : 0;
      continue;
    }
    if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      targetDuration = Number(line.split(":")[1]) || targetDuration;
      continue;
    }
    if (line.startsWith("#EXTINF:")) {
      const dur = Number(line.slice(8).split(",")[0]);
      segments.push({ duration: Number.isFinite(dur) ? dur : targetDuration, uri: null });
      continue;
    }
    if (line.startsWith("#")) continue;

    if (pendingBandwidth != null) {
      variants.push({
        uri: line,
        bandwidth: pendingBandwidth || 0,
        pixels: pendingResolution || 0,
      });
      pendingBandwidth = null;
      pendingResolution = null;
      continue;
    }

    if (segments.length && segments[segments.length - 1].uri == null) {
      segments[segments.length - 1].uri = line;
    } else {
      segments.push({ duration: targetDuration, uri: line });
    }
  }

  return { variants, segments, targetDuration };
}

async function pickMediaPlaylist(masterUrl) {
  const { text, finalUrl } = await fetchText(masterUrl);
  const parsed = parseM3u8(text);

  if (parsed.variants.length) {
    parsed.variants.sort((a, b) => {
      if (b.pixels !== a.pixels) return b.pixels - a.pixels;
      return b.bandwidth - a.bandwidth;
    });
    const best = parsed.variants[0];
    const mediaUrl = resolveUrl(finalUrl, best.uri);
    const media = await fetchText(mediaUrl);
    return {
      ...parseM3u8(media.text),
      playlistUrl: media.finalUrl,
    };
  }

  return { ...parsed, playlistUrl: finalUrl };
}

async function downloadSegment(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "*/*" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching segment`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Capture ~durationSecs of live HLS by downloading recent TS segments
 * (no ffmpeg — works on Vercel serverless).
 */
async function captureHlsClip({
  imageId = IMAGE_ID,
  durationSecs = 45,
  maxWaitMs = 55_000,
} = {}) {
  const signedUrl = await getSignedVideoUrl(imageId);
  const started = Date.now();
  const seen = new Set();
  const chunks = [];
  let capturedSecs = 0;
  let playlistUrl = null;
  let targetDuration = 6;

  while (capturedSecs < durationSecs && Date.now() - started < maxWaitMs) {
    const media = await pickMediaPlaylist(playlistUrl || signedUrl);
    playlistUrl = media.playlistUrl;
    targetDuration = media.targetDuration || targetDuration;

    for (const seg of media.segments) {
      if (!seg.uri || seen.has(seg.uri)) continue;
      seen.add(seg.uri);
      const abs = resolveUrl(playlistUrl, seg.uri);
      chunks.push(await downloadSegment(abs));
      capturedSecs += seg.duration || targetDuration;
      if (capturedSecs >= durationSecs) break;
    }

    if (capturedSecs >= durationSecs) break;
    await new Promise((r) => setTimeout(r, Math.min(2000, targetDuration * 500)));
  }

  if (!chunks.length) {
    throw new Error("No HLS segments captured — stream may be offline");
  }

  return {
    buffer: Buffer.concat(chunks),
    durationMs: Math.round(capturedSecs * 1000),
    segmentCount: chunks.length,
    contentType: "video/mp2t",
    extension: "ts",
  };
}

async function uploadClipBuffer({
  buffer,
  contentType,
  extension,
  durationMs,
  source = "cron",
}) {
  const supabase = getServiceClient();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `FORS-0021_${stamp}_${source}.${extension}`;
  const storagePath = `${CAMERA_ID || "camera"}/${stamp}_${filename}`;

  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, buffer, {
      contentType,
      upsert: false,
    });
  if (upErr) throw upErr;

  const { data, error: metaErr } = await supabase
    .from("recordings")
    .insert({
      filename,
      storage_path: storagePath,
      content_type: contentType,
      size_bytes: buffer.length,
      camera_id: String(CAMERA_ID),
      duration_ms: durationMs,
    })
    .select("id, filename, storage_path, size_bytes, duration_ms, created_at")
    .single();
  if (metaErr) throw metaErr;

  return {
    id: data.id,
    name: data.filename,
    path: data.storage_path,
    size: Number(data.size_bytes || 0),
    durationMs: data.duration_ms,
    mtime: data.created_at,
  };
}

module.exports = {
  captureHlsClip,
  uploadClipBuffer,
};
