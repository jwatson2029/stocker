(() => {
  const player = document.getElementById("player");
  const still = document.getElementById("still");
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
  const sessionRecordings = [];

  function setStatus(kind, label) {
    liveStatus.classList.remove("live", "recording", "error");
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
        "Records in-browser (WebM). Downloads when you stop. Keep the tab open.";
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
        manifestLoadingMaxRetry: 6,
        levelLoadingMaxRetry: 6,
        fragLoadingMaxRetry: 6,
      });
      hls.loadSource(url);
      hls.attachMedia(player);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
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
    if (!sessionRecordings.length) {
      recordingList.innerHTML = `<li class="empty">No recordings yet this session</li>`;
      return;
    }
    recordingList.innerHTML = sessionRecordings
      .map(
        (r, i) => `
      <li>
        <p class="rec-name">${r.name}</p>
        <p class="rec-meta">${formatBytes(r.size)} · ${new Date(r.mtime).toLocaleString()}</p>
        <div class="rec-actions">
          <a class="btn" href="${r.url}" download="${r.name}">Download</a>
          <a class="btn" href="${r.url}" target="_blank" rel="noopener">Open</a>
          <button type="button" class="btn btn-danger" data-delete-index="${i}">Remove</button>
        </div>
      </li>`
      )
      .join("");
  }

  function startRecording() {
    if (!window.MediaRecorder) {
      throw new Error("MediaRecorder not supported in this browser");
    }
    const capture =
      player.captureStream || player.mozCaptureStream;
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
      const type = recordMime || "video/webm";
      const blob = new Blob(recordedChunks, { type });
      const ext = type.includes("mp4") ? "mp4" : "webm";
      const name = `FORS-0021_${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`;
      const url = URL.createObjectURL(blob);
      sessionRecordings.unshift({
        name,
        url,
        size: blob.size,
        mtime: new Date().toISOString(),
      });
      renderRecordings();

      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();

      recordHint.textContent = `Downloaded ${name}`;
      mediaRecorder = null;
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
    renderRecordings();
  });

  recordingList.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-delete-index]");
    if (!btn) return;
    const index = Number(btn.getAttribute("data-delete-index"));
    const item = sessionRecordings[index];
    if (item) URL.revokeObjectURL(item.url);
    sessionRecordings.splice(index, 1);
    renderRecordings();
  });

  loadCamera().catch((err) => {
    setStatus("error", "Camera metadata failed");
    console.error(err);
  });
  attachStream();
  refreshStill();
  renderRecordings();

  setInterval(refreshStill, 60_000);
  // Stream tokens expire in ~2 minutes — refresh before that.
  setInterval(refreshStreamToken, 90_000);
})();
