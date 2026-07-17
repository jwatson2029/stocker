require("dotenv").config();
const { handleRecordingsApi } = require("../../lib/recordings");

module.exports = async function handler(req, res) {
  if (req.method === "DELETE") {
    await handleRecordingsApi(req, res, "delete");
    return;
  }
  await handleRecordingsApi(req, res, "list");
};
