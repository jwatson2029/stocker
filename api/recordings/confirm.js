require("dotenv").config();
const { handleRecordingsApi } = require("../../lib/recordings");

module.exports = async function handler(req, res) {
  await handleRecordingsApi(req, res, "confirm");
};
