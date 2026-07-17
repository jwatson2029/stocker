const { getSignedVideoUrl, IMAGE_ID, setCors } = require("../lib/ga511");

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  try {
    const incoming = new URL(req.url, "http://localhost");
    const imageId =
      incoming.searchParams.get("imageId") ||
      (req.query && req.query.imageId) ||
      IMAGE_ID;
    const url = await getSignedVideoUrl(imageId);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ url, imageId }));
  } catch (err) {
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: err.message }));
  }
};
