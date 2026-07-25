(() => {
  const player = document.getElementById("player");
  const still = document.getElementById("still");
  const motionOverlay = document.getElementById("motionOverlay");
  const motionHud = document.getElementById("motionHud");
  const motionHudLabel = document.getElementById("motionHudLabel");
  const liveStatus = document.getElementById("liveStatus");
  const liveLabel = document.getElementById("liveLabel");
  const cameraTitle = document.getElementById("cameraTitle");
  const cameraLocation = document.getElementById("cameraLocation");
  const metaList = document.getElementById("metaList");
  const recordingList = document.getElementById("recordingList");
  const recordHint = document.getElementById("recordHint");
  const recordTimer = document.getElementById("recordTimer");
  const btnRefresh = document.getElementById("btnRefresh");
  const btnMute = document.getElementById("btnMute");
  const btnMotion = document.getElementById("btnMotion");
  const btnRecord = document.getElementById("btnRecord");
  const btnStop = document.getElementById("btnStop");
  const btnReloadList = document.getElementById("btnReloadList");

  let hls = null;
  let recordStartedAt = null;
  let timerId = null;
  let isRecording = false;
  let mediaRecorder = null;
  let recordedChunks = [];
  let recordMime = "video/webm";
  let cameraId = "12084";
  let recordings = [];
  let motionEnabled = true;
  let motionRaf = 0;
  let motionTimer = 0;
  let prevGray = null;
  let trackedBoxes = [];
  let lastMotionAt = 0;
  let motionBusy = false;

  const SAMPLE_W = 80;
  const SAMPLE_H = 45;
  const GRID_COLS = 16;
  const GRID_ROWS = 9;
  const PIXEL_THRESH = 26;
  const CELL_RATIO = 0.16;
  const MIN_CELLS = 2;
  const BOX_HOLD_MS = 900;
  const MOTION_INTERVAL_MS = 350;
  const sampleCanvas = document.createElement("canvas");
  sampleCanvas.width = SAMPLE_W;
  sampleCanvas.height = SAMPLE_H;
  const sampleCtx = sampleCanvas.getContext("2d", {
    willReadFrequently: true,
    alpha: false,
  });
  const overlayCtx = motionOverlay.getContext("2d");
  const analysisImg = new Image();
  analysisImg.decoding = "async";

  function setStatus(kind, label) {
    liveStatus.classList.remove("live", "recording", "error", "motion");
    if (kind) liveStatus.classList.add(kind);
    liveLabel.textContent = label;
  }

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  function formatDuration(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = String(Math.floor(total / 3600)).padStart(2, "0");
    const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
    const s = String(total % 60).padStart(2, "0");
    return `${h}:${m}:${s}`;
  }

  function tickTimer() {
    if (!recordStartedAt) return;
    recordTimer.textContent = formatDuration(Date.now() - recordStartedAt);
  }

  function startTimer() {
    recordStartedAt = Date.now();
    recordTimer.hidden = false;
    tickTimer();
    clearInterval(timerId);
    timerId = setInterval(tickTimer, 250);
  }

  function stopTimer() {
    clearInterval(timerId);
    timerId = null;
    recordStartedAt = null;
    recordTimer.hidden = true;
    recordTimer.textContent = "00:00:00";
  }

  function setRecordingUi(active) {
    isRecording = active;
    btnRecord.disabled = active;
    btnStop.disabled = !active;
    btnRecord.classList.toggle("active", active);
    btnRecord.textContent = active ? "Recording…" : "Start recording";
    if (active) {
      startTimer();
      setStatus("recording", "Recording");
      recordHint.textContent = "Recording in this browser tab — keep the tab open";
    } else {
      stopTimer();
      setStatus("live", "Live");
      recordHint.textContent =
        "Browser capture uploads to Supabase. For 24/7, deploy the Render worker (render.yaml) or run: npm run record:24x7";

    }
  }

  function getVideoContentRect() {
    const vw = player.videoWidth;
    const vh = player.videoHeight;
    const cw = player.clientWidth;
    const ch = player.clientHeight;
    if (!vw || !vh || !cw || !ch) {
      return { x: 0, y: 0, w: cw || 1, h: ch || 1 };
    }
    const scale = Math.min(cw / vw, ch / vh);
    const w = vw * scale;
    const h = vh * scale;
    return {
      x: (cw - w) / 2,
      y: (ch - h) / 2,
      w,
      h,
    };
  }

  function syncOverlaySize() {
    const wrap = motionOverlay.parentElement;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    if (motionOverlay.width !== w || motionOverlay.height !== h) {
      motionOverlay.width = w;
      motionOverlay.height = h;
    }
  }

  function toGray(data) {
    const gray = new Uint8Array(SAMPLE_W * SAMPLE_H);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      gray[p] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
    }
    return gray;
  }

  function detectMotionBoxesFromGray(gray) {
    if (!prevGray) {
      prevGray = gray;
      return [];
    }

    const cellW = Math.floor(SAMPLE_W / GRID_COLS);
    const cellH = Math.floor(SAMPLE_H / GRID_ROWS);
    const hot = Array.from({ length: GRID_ROWS }, () => Array(GRID_COLS).fill(false));

    for (let gy = 0; gy < GRID_ROWS; gy++) {
      for (let gx = 0; gx < GRID_COLS; gx++) {
        let changed = 0;
        let total = 0;
        const x0 = gx * cellW;
        const y0 = gy * cellH;
        for (let y = y0; y < y0 + cellH; y++) {
          for (let x = x0; x < x0 + cellW; x++) {
            const i = y * SAMPLE_W + x;
            if (Math.abs(gray[i] - prevGray[i]) > PIXEL_THRESH) changed++;
            total++;
          }
        }
        hot[gy][gx] = total > 0 && changed / total >= CELL_RATIO;
      }
    }

    prevGray = gray;

    const visited = Array.from({ length: GRID_ROWS }, () => Array(GRID_COLS).fill(false));
    const clusters = [];

    for (let gy = 0; gy < GRID_ROWS; gy++) {
      for (let gx = 0; gx < GRID_COLS; gx++) {
        if (!hot[gy][gx] || visited[gy][gx]) continue;
        let minX = gx;
        let maxX = gx;
        let minY = gy;
        let maxY = gy;
        let count = 0;
        const stack = [[gx, gy]];
        visited[gy][gx] = true;
        while (stack.length) {
          const [cx, cy] = stack.pop();
          count++;
          minX = Math.min(minX, cx);
          maxX = Math.max(maxX, cx);
          minY = Math.min(minY, cy);
          maxY = Math.max(maxY, cy);
          const neighbors = [
            [cx - 1, cy],
            [cx + 1, cy],
            [cx, cy - 1],
            [cx, cy + 1],
            [cx - 1, cy - 1],
            [cx + 1, cy - 1],
            [cx - 1, cy + 1],
            [cx + 1, cy + 1],
          ];
          for (const [nx, ny] of neighbors) {
            if (
              nx < 0 ||
              ny < 0 ||
              nx >= GRID_COLS ||
              ny >= GRID_ROWS ||
              visited[ny][nx] ||
              !hot[ny][nx]
            ) {
              continue;
            }
            visited[ny][nx] = true;
            stack.push([nx, ny]);
          }
        }
        if (count >= MIN_CELLS) {
          clusters.push({
            x: minX / GRID_COLS,
            y: minY / GRID_ROWS,
            w: (maxX - minX + 1) / GRID_COLS,
            h: (maxY - minY + 1) / GRID_ROWS,
            score: count,
          });
        }
      }
    }

    clusters.sort((a, b) => b.score - a.score);
    return clusters.slice(0, 6);
  }

  async function sampleMotionFrame() {
    if (!motionEnabled || motionBusy) return;
    motionBusy = true;
    try {
      // Same-origin still avoids CORS tainting on the cross-origin HLS video.
      const url = `/api/still?t=${Date.now()}`;
      analysisImg.src = url;
      await analysisImg.decode();
      sampleCtx.drawImage(analysisImg, 0, 0, SAMPLE_W, SAMPLE_H);
      const frame = sampleCtx.getImageData(0, 0, SAMPLE_W, SAMPLE_H);
      const raw = detectMotionBoxesFromGray(toGray(frame.data));
      const boxes = mergeTracked(raw);
      renderMotionOverlay(boxes);
      updateMotionHud(boxes.length);
    } catch (err) {
      // Keep last boxes briefly if a still fails.
      const boxes = mergeTracked([]);
      renderMotionOverlay(boxes);
      updateMotionHud(boxes.length);
    } finally {
      motionBusy = false;
    }
  }

  function mergeTracked(rawBoxes) {
    const now = Date.now();
    if (rawBoxes.length) lastMotionAt = now;

    const next = rawBoxes.map((box) => {
      const match = trackedBoxes.find((t) => {
        const cx = box.x + box.w / 2;
        const cy = box.y + box.h / 2;
        const tx = t.box.x + t.box.w / 2;
        const ty = t.box.y + t.box.h / 2;
        return Math.hypot(cx - tx, cy - ty) < 0.22;
      });
      if (match) {
        const a = 0.5;
        return {
          box: {
            x: match.box.x * (1 - a) + box.x * a,
            y: match.box.y * (1 - a) + box.y * a,
            w: match.box.w * (1 - a) + box.w * a,
            h: match.box.h * (1 - a) + box.h * a,
          },
          seenAt: now,
        };
      }
      return { box, seenAt: now };
    });

    for (const t of trackedBoxes) {
      if (
        now - t.seenAt < BOX_HOLD_MS &&
        !next.some(
          (n) =>
            Math.hypot(
              n.box.x + n.box.w / 2 - (t.box.x + t.box.w / 2),
              n.box.y + n.box.h / 2 - (t.box.y + t.box.h / 2)
            ) < 0.22
        )
      ) {
        next.push(t);
      }
    }

    trackedBoxes = next.slice(0, 6);
    return trackedBoxes.map((t) => t.box);
  }

  function drawCornerBox(ctx, x, y, w, h, len) {
    const L = Math.min(len, w * 0.35, h * 0.35);
    ctx.beginPath();
    ctx.moveTo(x, y + L);
    ctx.lineTo(x, y);
    ctx.lineTo(x + L, y);
    ctx.moveTo(x + w - L, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w, y + L);
    ctx.moveTo(x + w, y + h - L);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x + w - L, y + h);
    ctx.moveTo(x + L, y + h);
    ctx.lineTo(x, y + h);
    ctx.lineTo(x, y + h - L);
    ctx.stroke();
  }

  function renderMotionOverlay(boxes) {
    syncOverlaySize();
    overlayCtx.clearRect(0, 0, motionOverlay.width, motionOverlay.height);
    if (!motionEnabled || !boxes.length) return;

    const rect = getVideoContentRect();
    const videoOffsetX = player.offsetLeft;
    const videoOffsetY = player.offsetTop;

    overlayCtx.save();
    overlayCtx.strokeStyle = "rgba(62, 207, 142, 0.95)";
    overlayCtx.lineWidth = 2;
    overlayCtx.lineJoin = "miter";
    overlayCtx.font = '600 11px "IBM Plex Mono", monospace';
    overlayCtx.textBaseline = "bottom";

    boxes.forEach((box, i) => {
      const x = videoOffsetX + rect.x + box.x * rect.w;
      const y = videoOffsetY + rect.y + box.y * rect.h;
      const w = Math.max(18, box.w * rect.w);
      const h = Math.max(18, box.h * rect.h);

      overlayCtx.fillStyle = "rgba(62, 207, 142, 0.08)";
      overlayCtx.fillRect(x, y, w, h);
      drawCornerBox(overlayCtx, x, y, w, h, 14);

      overlayCtx.fillStyle = "rgba(62, 207, 142, 0.95)";
      overlayCtx.fillText(`OBJ ${String(i + 1).padStart(2, "0")}`, x + 4, y - 4);
    });

    overlayCtx.restore();
  }

  function updateMotionHud(activeCount) {
    const showing = motionEnabled && activeCount > 0;
    motionHud.hidden = !showing;
    if (showing) {
      motionHudLabel.textContent =
        activeCount === 1 ? "Motion" : `Motion ×${activeCount}`;
      if (!isRecording) setStatus("motion", "Motion");
    } else if (!isRecording && liveStatus.classList.contains("motion")) {
      setStatus("live", "Live");
    }
  }

  function startMotionLoop() {
    stopMotionLoop();
    sampleMotionFrame();
    motionTimer = setInterval(sampleMotionFrame, MOTION_INTERVAL_MS);
    const paint = () => {
      motionRaf = requestAnimationFrame(paint);
      if (!motionEnabled) return;
      if (trackedBoxes.length) {
        renderMotionOverlay(trackedBoxes.map((t) => t.box));
      }
    };
    motionRaf = requestAnimationFrame(paint);
  }

  function stopMotionLoop() {
    clearInterval(motionTimer);
    motionTimer = 0;
    cancelAnimationFrame(motionRaf);
    motionRaf = 0;
  }

  function setMotionEnabled(on) {
    motionEnabled = on;
    btnMotion.classList.toggle("active", on);
    btnMotion.setAttribute("aria-pressed", on ? "true" : "false");
    btnMotion.textContent = on ? "Motion on" : "Motion off";
    if (!on) {
      trackedBoxes = [];
      prevGray = null;
      stopMotionLoop();
      overlayCtx.clearRect(0, 0, motionOverlay.width, motionOverlay.height);
      motionHud.hidden = true;
      if (!isRecording && liveStatus.classList.contains("motion")) {
        setStatus("live", "Live");
      }
    } else {
      startMotionLoop();
    }
  }

  function pickMimeType() {
    const types = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm;codecs=vp9",
      "video/webm",
      "video/mp4",
    ];
    if (!window.MediaRecorder) return null;
    return types.find((t) => MediaRecorder.isTypeSupported(t)) || "";
  }

  async function fetchSignedUrl() {
    const res = await fetch(`/api/video-url?t=${Date.now()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to get video URL");
    return data.url;
  }

  async function attachStream() {
    setStatus("", "Connecting…");
    let url;
    try {
      url = await fetchSignedUrl();
    } catch (err) {
      setStatus("error", "Token fetch failed");
      console.error(err);
      setTimeout(attachStream, 3000);
      return;
    }

    if (hls) {
      hls.destroy();
      hls = null;
    }

    if (window.Hls && Hls.isSupported()) {
      hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        liveDurationInfinity: true,
        // Prefer the highest available quality; do not downscale to player size.
        startLevel: -1,
        autoStartLoad: true,
        capLevelToPlayerSize: false,
        manifestLoadingMaxRetry: 6,
        levelLoadingMaxRetry: 6,
        fragLoadingMaxRetry: 6,
      });
      hls.loadSource(url);
      hls.attachMedia(player);
      hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
        const levels = data?.levels || [];
        if (levels.length > 1) {
          let best = 0;
          for (let i = 1; i < levels.length; i++) {
            const a = (levels[i].width || 0) * (levels[i].height || 0);
            const b = (levels[best].width || 0) * (levels[best].height || 0);
            if (a > b || (a === b && (levels[i].bitrate || 0) > (levels[best].bitrate || 0))) {
              best = i;
            }
          }
          hls.currentLevel = best;
          hls.nextLevel = best;
          hls.loadLevel = best;
        }
        player.play().catch(() => {});
        if (!isRecording) setStatus("live", "Live");
      });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        console.error("HLS error", data);
        setStatus("error", "Stream error — retrying");
        setTimeout(attachStream, 2000);
      });
    } else if (player.canPlayType("application/vnd.apple.mpegurl")) {
      player.src = url;
      player.addEventListener(
        "loadedmetadata",
        () => {
          player.play().catch(() => {});
          if (!isRecording) setStatus("live", "Live");
        },
        { once: true }
      );
    } else {
      setStatus("error", "HLS not supported");
    }
  }

  async function refreshStreamToken() {
    try {
      const url = await fetchSignedUrl();
      if (hls) {
        hls.loadSource(url);
      } else if (player.canPlayType("application/vnd.apple.mpegurl")) {
        const t = player.currentTime;
        player.src = url;
        player.addEventListener(
          "loadedmetadata",
          () => {
            player.currentTime = t;
            player.play().catch(() => {});
          },
          { once: true }
        );
      }
    } catch (err) {
      console.error("Token refresh failed", err);
    }
  }

  async function loadCamera() {
    const res = await fetch("/api/camera");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to load camera");

    const cam = data.camera || {};
    cameraId = String(data.cameraId || cameraId);
    const title = cam.Name || "FORS-CCTV-0021";
    const location =
      cam.Location || "SR 141 at Ronald Reagan Blvd (Forsyth)";
    cameraTitle.textContent = title;
    cameraLocation.textContent = location;
    document.title = `Stocker — ${title}`;

    metaList.innerHTML = `
      <div><dt>Camera ID</dt><dd>${data.cameraId}</dd></div>
      <div><dt>View ID</dt><dd>${data.imageId}</dd></div>
      <div><dt>Roadway</dt><dd>${cam.Roadway || "—"}</dd></div>
      <div><dt>Direction</dt><dd>${cam.Direction || "—"}</dd></div>
      <div><dt>Coords</dt><dd>${cam.Latitude ?? "—"}, ${cam.Longitude ?? "—"}</dd></div>
      <div><dt>Source</dt><dd>${cam.Source || "—"}</dd></div>
    `;
  }

  function refreshStill() {
    still.src = `/api/still?t=${Date.now()}`;
  }

  function renderRecordings() {
    if (!recordings.length) {
      recordingList.innerHTML = `<li class="empty">No recordings in Supabase yet</li>`;
      return;
    }
    recordingList.innerHTML = recordings
      .map(
        (r) => `
      <li>
        <p class="rec-name">${r.name}</p>
        <p class="rec-meta">${formatBytes(r.size)} · ${new Date(r.mtime).toLocaleString()}</p>
        <div class="rec-actions">
          <a class="btn" href="${r.url}" download="${r.name}" target="_blank" rel="noopener">Download</a>
          <a class="btn" href="${r.url}" target="_blank" rel="noopener">Open</a>
          <button type="button" class="btn btn-danger" data-delete-id="${r.id}">Delete</button>
        </div>
      </li>`
      )
      .join("");
  }

  async function loadRecordings() {
    const res = await fetch("/api/recordings");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to load recordings");
    recordings = data.recordings || [];
    renderRecordings();
  }

  async function uploadToSupabase(blob, name, durationMs) {
    recordHint.textContent = `Uploading ${name} to Supabase…`;

    const prepareRes = await fetch("/api/recordings/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: name,
        contentType: blob.type || "video/webm",
        cameraId,
        size: blob.size,
      }),
    });
    const prepare = await prepareRes.json();
    if (!prepareRes.ok) throw new Error(prepare.error || "Prepare failed");

    const uploadRes = await fetch(prepare.signedUrl, {
      method: "PUT",
      headers: {
        "Content-Type": blob.type || prepare.contentType || "video/webm",
      },
      body: blob,
    });
    if (!uploadRes.ok) {
      const text = await uploadRes.text().catch(() => "");
      throw new Error(`Upload failed (${uploadRes.status}) ${text.slice(0, 120)}`);
    }

    const confirmRes = await fetch("/api/recordings/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: prepare.path,
        filename: name,
        contentType: blob.type || prepare.contentType || "video/webm",
        size: blob.size,
        cameraId,
        durationMs,
      }),
    });
    const saved = await confirmRes.json();
    if (!confirmRes.ok) throw new Error(saved.error || "Confirm failed");
    return saved;
  }

  function startRecording() {
    if (!window.MediaRecorder) {
      throw new Error("MediaRecorder not supported in this browser");
    }
    const capture = player.captureStream || player.mozCaptureStream;
    if (!capture) {
      throw new Error("Tab capture not supported — try Chrome or Edge");
    }
    if (player.readyState < 2) {
      throw new Error("Wait for the live video to start first");
    }

    recordMime = pickMimeType();
    if (recordMime === null) {
      throw new Error("MediaRecorder not supported");
    }

    const stream = capture.call(player);
    recordedChunks = [];
    const startedAt = Date.now();
    mediaRecorder = new MediaRecorder(
      stream,
      recordMime ? { mimeType: recordMime } : undefined
    );
    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recordedChunks.push(e.data);
    };
    mediaRecorder.onerror = (e) => {
      console.error(e);
      recordHint.textContent = "Recording error — see console";
      setRecordingUi(false);
    };
    mediaRecorder.onstop = () => {
      const durationMs = Date.now() - startedAt;
      const type = recordMime || "video/webm";
      const blob = new Blob(recordedChunks, { type });
      const ext = type.includes("mp4") ? "mp4" : "webm";
      const name = `FORS-0021_${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`;
      mediaRecorder = null;

      uploadToSupabase(blob, name, durationMs)
        .then(async (saved) => {
          recordHint.textContent = `Saved to Supabase: ${saved.name}`;
          await loadRecordings();
        })
        .catch((err) => {
          console.error(err);
          recordHint.textContent = err.message || "Upload failed";
          // Still offer a local download fallback
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = name;
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
        });
    };

    mediaRecorder.start(1000);
    setRecordingUi(true);
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
    }
    setRecordingUi(false);
  }

  btnRefresh.addEventListener("click", () => {
    setStatus("", "Refreshing…");
    attachStream();
    refreshStill();
  });

  btnMute.addEventListener("click", () => {
    player.muted = !player.muted;
    btnMute.textContent = player.muted ? "Unmute" : "Mute";
  });

  btnMotion.addEventListener("click", () => {
    setMotionEnabled(!motionEnabled);
  });

  btnRecord.addEventListener("click", () => {
    try {
      startRecording();
    } catch (err) {
      recordHint.textContent = err.message;
      btnRecord.disabled = false;
    }
  });

  btnStop.addEventListener("click", () => {
    stopRecording();
  });

  btnReloadList.addEventListener("click", () => {
    loadRecordings().catch((err) => {
      recordHint.textContent = err.message;
    });
  });

  recordingList.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-delete-id]");
    if (!btn) return;
    const id = btn.getAttribute("data-delete-id");
    if (!confirm("Delete this recording from Supabase?")) return;
    const res = await fetch(`/api/recordings/delete?id=${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    const data = await res.json();
    if (!res.ok) {
      recordHint.textContent = data.error || "Delete failed";
      return;
    }
    await loadRecordings();
  });

  loadCamera().catch((err) => {
    setStatus("error", "Camera metadata failed");
    console.error(err);
  });
  attachStream();
  refreshStill();
  loadRecordings().catch((err) => {
    recordingList.innerHTML = `<li class="empty">${err.message}</li>`;
  });

  setInterval(refreshStill, 30_000);
  setInterval(refreshStreamToken, 90_000);
  window.addEventListener("resize", () => {
    syncOverlaySize();
    if (trackedBoxes.length) {
      renderMotionOverlay(trackedBoxes.map((t) => t.box));
    }
  });
  player.addEventListener("loadeddata", () => {
    syncOverlaySize();
  });
  startMotionLoop();
})();
