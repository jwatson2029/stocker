const IMAGE_ID = process.env.IMAGE_ID || "19494";
const CAMERA_ID = process.env.CAMERA_ID || "12084";
const API_KEY = process.env.API_KEY || "ffb47ecb542a439fa4f0245fe3b3f5ab";

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "stocker/1.0", Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function getSignedVideoUrl(imageId = IMAGE_ID) {
  const data = await fetchJson(
    `https://511ga.org/Camera/GetVideoUrl?imageId=${encodeURIComponent(imageId)}&_=${Date.now()}`
  );
  return typeof data === "string" ? data : String(data);
}

async function getCamera() {
  const cameras = await fetchJson(
    `https://511ga.org/api/v2/get/cameras?key=${encodeURIComponent(API_KEY)}&format=json`
  );
  const camera = cameras.find((c) => String(c.Id) === String(CAMERA_ID)) || null;
  const view =
    camera?.Views?.find((v) => String(v.Id) === String(IMAGE_ID)) ||
    camera?.Views?.[0] ||
    null;
  return {
    cameraId: CAMERA_ID,
    imageId: IMAGE_ID,
    camera,
    view,
    stillUrl: "/api/still",
  };
}

async function getStillBuffer() {
  const res = await fetch(`https://511ga.org/map/Cctv/${IMAGE_ID}?_=${Date.now()}`, {
    headers: { "User-Agent": "stocker/1.0", Accept: "image/*" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching still`);
  const contentType = res.headers.get("content-type") || "image/png";
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType };
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "no-store");
}

module.exports = {
  IMAGE_ID,
  CAMERA_ID,
  API_KEY,
  getSignedVideoUrl,
  getCamera,
  getStillBuffer,
  setCors,
};
