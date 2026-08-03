/**
 * Eastern-friendly stamps for recording filenames.
 * Default zone: America/New_York (EST/EDT).
 */
const RECORD_TZ = process.env.RECORD_TZ || "America/New_York";

/**
 * @param {Date} [date]
 * @returns {string} e.g. "2026-08-03_13-19-45"
 */
function estDateTimeStamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: RECORD_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const get = (type) => parts.find((p) => p.type === type)?.value || "00";
  return `${get("year")}-${get("month")}-${get("day")}_${get("hour")}-${get("minute")}-${get("second")}`;
}

module.exports = {
  RECORD_TZ,
  estDateTimeStamp,
};
