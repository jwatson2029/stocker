#!/usr/bin/env node
/**
 * Creates the recordings storage bucket + metadata table in Supabase.
 * Usage: node scripts/setup-supabase.js
 */
require("dotenv").config();

const { getServiceClient, BUCKET } = require("../lib/supabase");

async function main() {
  const supabase = getServiceClient();

  const { data: buckets, error: listErr } = await supabase.storage.listBuckets();
  if (listErr) throw listErr;

  const exists = (buckets || []).some((b) => b.name === BUCKET);
  if (!exists) {
    const { error } = await supabase.storage.createBucket(BUCKET, {
      public: true,
    });
    if (error) throw error;
    console.log(`Created bucket: ${BUCKET}`);
  } else {
    console.log(`Bucket already exists: ${BUCKET}`);
  }

  const sql = `
create table if not exists public.recordings (
  id uuid primary key default gen_random_uuid(),
  filename text not null,
  storage_path text not null unique,
  content_type text,
  size_bytes bigint,
  camera_id text,
  duration_ms integer,
  created_at timestamptz not null default now()
);

create index if not exists recordings_created_at_idx
  on public.recordings (created_at desc);

alter table public.recordings enable row level security;
`;

  // Prefer rpc exec if available; otherwise use PostgREST schema via REST isn't enough.
  // Use the Postgres REST SQL endpoint isn't standard — use supabase.rpc or mgmt.
  // Falling back to raw fetch against the SQL API isn't available on all plans.
  // We'll insert a probe and create via storage + instruct, OR use pg via fetch to db.
  // Supabase JS doesn't run arbitrary SQL without the database URL.
  // Use POSTGRES_URL if present, else try supabase.from after manual note.

  const { Client } = await loadPg();
  if (!Client) {
    console.log("\nRun this SQL in the Supabase SQL editor:\n");
    console.log(sql);
    console.log("Bucket is ready. Table SQL printed above.");
    return;
  }

  const connectionString =
    process.env.POSTGRES_URL_NON_POOLING ||
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL;
  if (!connectionString) {
    console.log("\nNo POSTGRES_URL set. Run this SQL in the Supabase SQL editor:\n");
    console.log(sql);
    return;
  }

  const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });
  // Force node to accept Supabase pooler certs on some local setups
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  await client.connect();
  await client.query(sql);
  await client.end();
  console.log("Created/verified public.recordings table");
  console.log("Supabase setup complete.");
}

async function loadPg() {
  try {
    return require("pg");
  } catch {
    return {};
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
