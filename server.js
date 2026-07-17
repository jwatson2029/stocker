const http = require("http");
const fs = require("fs");
const path = require("path");
const {
  getCamera,
  getSignedVideoUrl,
  getStillBuffer,
  IMAGE_ID,
} = require("./lib/ga511");

const PORT = process.env.PORT || 3456;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

async function handleApi(req, res, pathname, searchParams) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && pathname === "/api/camera") {
    try {
      sendJson(res, 200, await getCamera());
    } catch (err) {
      sendJson(res, 502, { error: err.message });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/video-url") {
    try {
      const imageId = searchParams.get("imageId") || IMAGE_ID;
      const url = await getSignedVideoUrl(imageId);
      sendJson(res, 200, { url, imageId });
    } catch (err) {
      sendJson(res, 502, { error: err.message });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/still") {
    try {
      const { buffer, contentType } = await getStillBuffer();
      res.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
        "Content-Length": buffer.length,
        "Access-Control-Allow-Origin": "*",
      });
      res.end(buffer);
    } catch (err) {
      sendJson(res, 502, { error: err.message });
    }
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

function serveStatic(res, pathname) {
  const rel = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(
    PUBLIC_DIR,
    path.normalize(rel).replace(/^(\.\.[/\\])+/, "")
  );
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=3600",
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url.pathname, url.searchParams);
      return;
    }
    serveStatic(res, url.pathname);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Stocker local server at http://localhost:${PORT}`);
  console.log("Same API surface as Vercel (/api/camera, /api/video-url, /api/still)");
});
