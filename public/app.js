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
  const btnRefresh = document.getElementById("btnRefresh");
  const btnReloadList = document.getElementById("btnReloadList");

  let hls = null;
  let cameraId = "12084";
  let recordings = [];

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
        setStatus("live", "Live");
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
          setStatus("live", "Live");
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

  btnRefresh.addEventListener("click", () => {
    setStatus("", "Refreshing…");
    attachStream();
    refreshStill();
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
})();
