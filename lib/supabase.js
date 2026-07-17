const { createClient } = require("@supabase/supabase-js");

const BUCKET = "recordings";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

function getServiceClient() {
  const url = requireEnv("SUPABASE_URL");
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function publicObjectUrl(path) {
  const base = requireEnv("SUPABASE_URL").replace(/\/$/, "");
  return `${base}/storage/v1/object/public/${BUCKET}/${path}`;
}

module.exports = {
  BUCKET,
  getServiceClient,
  publicObjectUrl,
  requireEnv,
};
