// Fork-only (nguquen/kache-action): choose where a job may write in the S3
// remote, independent of GitHub branch protection.
//
// kache publishes to a remote only from a GitHub `push` to a protected branch
// (`is_trusted_github_writer`, kache src/policy.rs) and has no override. A
// pull request job may instead write to its own `pull_request_prefix`, while
// still reading the base prefix first. Repos without branch protection would
// otherwise never write at all, so two inputs pick a mode explicitly:
//
//   trusted-writer: true  -> write the base prefix (s3-prefix)
//   write-prefix: <p>     -> read s3-prefix, then <p>; write only <p>
//
// The mode is carried by overriding the GitHub variables kache reads, for kache
// processes only: a shim named `kache` sets them and execs the real binary.
// Every kache process re-reads the environment (the rustc wrapper, the daemon
// it spawns, `sync --push` and `daemon stop` in the post step), so all of them
// go through the shim. The action's own process keeps the real values.
const fs = require("fs");
const path = require("path");

const SHIM_NAME = "kache";

/** Mirror kache's prefix normalization closely enough to compare prefixes. */
function normalizePrefix(prefix) {
  return String(prefix || "")
    .trim()
    .replace(/^\/+|\/+$/g, "");
}

/** kache rejects a pull request prefix equal to, inside, or containing the
 *  base prefix (`pull_request_prefix_for`, kache src/config.rs). Reject it
 *  here too, where the error names the inputs instead of leaving the job
 *  silently read-only. */
function prefixesOverlap(base, other) {
  const nested = (outer, inner) =>
    outer === "" || inner === outer || inner.startsWith(`${outer}/`);
  return nested(base, other) || nested(other, base);
}

/** Resolve the write mode from the action inputs.
 *  Returns { mode: "default" | "trusted" | "prefix", env, pullRequestPrefix }. */
function resolveWriteMode({
  trustedWriter,
  writePrefix,
  basePrefix,
  s3,
  saveCache,
  platform,
  version,
}) {
  const prefix = normalizePrefix(writePrefix);
  if (!trustedWriter && !prefix) {
    return { mode: "default", env: {}, pullRequestPrefix: null };
  }
  if (trustedWriter && prefix) {
    throw new Error("trusted-writer and write-prefix are mutually exclusive");
  }
  const input = trustedWriter ? "trusted-writer" : "write-prefix";
  if (!s3) {
    throw new Error(`${input} requires an S3 remote (s3-bucket)`);
  }
  if (!saveCache) {
    throw new Error(`${input} cannot be combined with save-cache: false`);
  }
  if (platform === "win32") {
    throw new Error(`${input} is not supported on Windows runners`);
  }
  // The overrides lean on undocumented kache behaviour, so a write mode only
  // runs the kache release it was tested with, never "latest".
  if (!String(version || "").trim()) {
    throw new Error(`${input} requires an explicit version (e.g. version: v0.28.1)`);
  }
  if (trustedWriter) {
    return {
      mode: "trusted",
      env: {
        GITHUB_EVENT_NAME: "push",
        GITHUB_REF_TYPE: "branch",
        GITHUB_REF_PROTECTED: "true",
      },
      pullRequestPrefix: null,
    };
  }
  const base = normalizePrefix(basePrefix);
  if (prefixesOverlap(base, prefix)) {
    throw new Error(
      `write-prefix ${JSON.stringify(prefix)} must differ from s3-prefix ` +
        `${JSON.stringify(base)} and neither may contain the other`,
    );
  }
  return {
    mode: "prefix",
    env: { GITHUB_EVENT_NAME: "pull_request" },
    pullRequestPrefix: prefix,
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** The shim script: export the overrides, then exec the real kache. */
function renderShim(realBin, env) {
  const lines = [
    "#!/bin/sh",
    "# Written by nguquen/kache-action: kache's write mode for this job.",
  ];
  for (const name of Object.keys(env).sort()) {
    lines.push(`export ${name}=${shellQuote(env[name])}`);
  }
  lines.push(`exec ${shellQuote(realBin)} "$@"`, "");
  return lines.join("\n");
}

/** Write the shim into `dir` and return its path. It is named `kache` so the
 *  cc crate still recognizes RUSTC_WRAPPER as kache (it matches the file name). */
function writeShim(dir, realBin, env) {
  fs.mkdirSync(dir, { recursive: true });
  const shimPath = path.join(dir, SHIM_NAME);
  fs.writeFileSync(shimPath, renderShim(realBin, env), { mode: 0o755 });
  fs.chmodSync(shimPath, 0o755);
  return shimPath;
}

/** Check that kache took the mode, after the daemon started.
 *  `doctor` is the parsed `kache doctor --json`; `status` the parsed
 *  `kache daemon status --json`. Returns { ok, detail }. */
function verifyWriteMode(mode, { doctor, status }) {
  if (mode === "trusted") {
    const check = (doctor?.checks || []).find((c) => c.label === "Remote writes");
    if (!check) {
      return { ok: false, detail: "`kache doctor --json` has no Remote writes check" };
    }
    return check.detail === "read-write"
      ? { ok: true, detail: "remote writes: read-write" }
      : { ok: false, detail: `remote writes: ${check.detail}` };
  }
  if (mode === "prefix") {
    // A daemon serving a pull request prefix listens on a socket named after
    // it (`pull_request_scope`, kache src/config.rs). An unscoped socket means
    // kache did not treat this job as a pull request job.
    const socket = path.basename(status?.socket || "");
    return /^daemon-pr-[0-9a-f]+\.sock$/.test(socket)
      ? { ok: true, detail: `daemon socket ${socket}` }
      : { ok: false, detail: `daemon socket ${socket || "(none)"} is not prefix-scoped` };
  }
  return { ok: true, detail: "default mode" };
}

/** Count successful daemon uploads in kache's transfers.jsonl content. A
 *  failed upload is logged too, with `ok: false`, and published nothing. */
function countUploads(rawTransfers) {
  let uploads = 0;
  for (const line of String(rawTransfers || "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const t = JSON.parse(line);
      if (t.direction === "upload" && t.ok !== false) uploads++;
    } catch {
      // skip malformed lines
    }
  }
  return uploads;
}

/** Artifacts `kache sync --push` reported pushing, from its "Plan:" line. */
function countSyncPushed(syncOutput) {
  const match = /Plan: pull \d+ artifacts?, push (\d+) artifacts?/.exec(
    String(syncOutput || ""),
  );
  return match ? Number(match[1]) : 0;
}

/** kache keeps build-script compiles and runs in the local store only
 *  (src/build_script.rs never enqueues an upload), so their misses say
 *  nothing about whether the write mode took. */
function isPublishableMiss(name) {
  return !String(name || "").startsWith("build_script_");
}

/** Downloads kache gave up on, from transfers.jsonl content: the same rule as
 *  `kache report`'s "Failed downloads" (not ok, and not a clean miss, a
 *  cancellation or a skip). kache then compiles the crate locally. */
function failedDownloads(rawTransfers) {
  const failed = [];
  for (const line of String(rawTransfers || "").split("\n")) {
    if (!line.trim()) continue;
    let t;
    try {
      t = JSON.parse(line);
    } catch {
      continue;
    }
    if (t.direction !== "download" || t.ok) continue;
    if (["not_found", "cancelled", "skipped"].includes(t.outcome)) continue;
    failed.push({
      name: t.crate_name || "",
      cacheKey: t.cache_key || "",
      elapsedMs: t.elapsed_ms || 0,
    });
  }
  return failed;
}

/** The daemon's upload counters from `kache telemetry write`'s
 *  metrics.otlp.json (`kache.cache.uploads`, one data point per
 *  `kache.cache.result`). They live only in the daemon's memory, so the file
 *  has to be written before `daemon stop`. Returns { completed, failed,
 *  skipped, suppressed }, or null when the metric is missing. */
function parseUploadCounters(rawMetrics) {
  let body;
  try {
    body = JSON.parse(String(rawMetrics || ""));
  } catch {
    return null;
  }
  for (const rm of body?.resourceMetrics || []) {
    for (const sm of rm?.scopeMetrics || []) {
      const metric = (sm?.metrics || []).find((m) => m?.name === "kache.cache.uploads");
      if (!metric) continue;
      const counters = { completed: 0, failed: 0, skipped: 0, suppressed: 0 };
      for (const point of metric.sum?.dataPoints || metric.gauge?.dataPoints || []) {
        const result = (point.attributes || []).find((a) => a.key === "kache.cache.result")
          ?.value?.stringValue;
        if (Object.hasOwn(counters, result)) counters[result] = Number(point.asInt ?? point.asDouble ?? 0) || 0;
      }
      return counters;
    }
  }
  return null;
}

/** A writing job that compiled something publishable but published nothing
 *  means kache stopped honouring the mode, which would otherwise read as a
 *  cold cache. `misses` is the parsed event list's missedCrates.
 *
 *  `uploadsSkipped` counts uploads the daemon dropped because the key was
 *  already in the remote. kache counts them only past its read-only gate, so
 *  they prove the write path ran: a crate compiled after a failed download
 *  of an existing entry is skipped, not uploaded, and must not fail the job.
 *  A job kache keeps read-only never gets that far and still reads 0. */
function uploadCheck({ mode, misses, uploads, syncPushed, uploadsSkipped = 0, uploadsFailed = 0, uploadsSuppressed = 0 }) {
  const publishable = (misses || []).filter((m) => isPublishableMiss(m.name)).length;
  if (mode === "default" || !publishable) return { ok: true };
  if (uploads + syncPushed + uploadsSkipped > 0) return { ok: true };
  const unfinished = uploadsFailed + uploadsSuppressed > 0
    ? ` (${uploadsFailed} upload(s) failed, ${uploadsSuppressed} suppressed by the write breaker)`
    : "";
  return {
    ok: false,
    detail:
      `${publishable} crate(s) compiled but nothing was uploaded in ${mode} write mode${unfinished}; ` +
      "kache may have changed how it decides remote writes",
  };
}

/** Step summary section for the write check, so a failure names its cause. */
function renderWriteCheckSummary({ mode, misses, uploads, syncPushed, counters, failed, check }) {
  const publishable = (misses || []).filter((m) => isPublishableMiss(m.name)).length;
  const compiledKeys = new Set((misses || []).map((m) => m.cache_key).filter(Boolean));
  const n = (value) => (counters ? String(value) : "?");
  const lines = [
    `#### kache write check (${mode} mode): ${check.ok ? "passed" : "failed"}`,
    "",
    "| | |",
    "|---|---:|",
    `| Compiled (publishable) | ${(misses || []).length} (${publishable}) |`,
    `| Uploaded by the daemon | ${uploads} |`,
    `| Pushed by \`sync --push\` | ${syncPushed} |`,
    `| Upload skipped, already in the remote | ${n(counters?.skipped)} |`,
    `| Upload failed | ${n(counters?.failed)} |`,
    `| Upload suppressed by the write breaker | ${n(counters?.suppressed)} |`,
    `| Failed downloads | ${failed.length} |`,
  ];
  if (failed.length) {
    lines.push("", "| Failed download | Key | After | Then |", "|---|---|---:|---|");
    for (const f of failed) {
      lines.push(
        `| \`${f.name}\` | \`${f.cacheKey.slice(0, 12)}\` | ${f.elapsedMs}ms | ${compiledKeys.has(f.cacheKey) ? "compiled" : "-"} |`,
      );
    }
  }
  if (!check.ok) lines.push("", check.detail);
  return lines.join("\n") + "\n";
}

/** Upload jobs still in kache's durable spool (`upload-queue`, or
 *  `upload-queue-pr-<hash>` under a write prefix). One file per job. */
function countQueuedUploads(cacheDir) {
  let total = 0;
  let dirs;
  try {
    dirs = fs.readdirSync(cacheDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const d of dirs) {
    if (!d.isDirectory() || !d.name.startsWith("upload-queue")) continue;
    try {
      total += fs
        .readdirSync(path.join(cacheDir, d.name), { withFileTypes: true })
        .filter((f) => f.isFile() && !f.name.startsWith(".")).length;
    } catch {
      // vanished between listings
    }
  }
  return total;
}

/** `daemon stop` gives queued uploads one shared 30s budget and then leaves
 *  the rest in the spool for the next daemon, which on a CI runner never
 *  comes. Wait for the spool to empty first, as long as it keeps shrinking.
 *  Resolves to the number of jobs still queued. */
async function waitForUploadQueue(
  cacheDir,
  { timeoutMs, stallMs = 60000, pollMs = 2000, count = countQueuedUploads, sleep, now = Date.now, log = () => {} },
) {
  const pause = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const start = now();
  let queued = count(cacheDir);
  let lowest = queued;
  let lastProgress = start;
  if (queued > 0) log(`Waiting for ${queued} queued kache upload(s)...`);
  while (queued > 0) {
    const t = now();
    if (t - start >= timeoutMs) {
      log(`Upload queue wait timed out after ${Math.round((t - start) / 1000)}s with ${queued} queued`);
      break;
    }
    if (t - lastProgress >= stallMs) {
      log(`Upload queue stalled at ${queued} for ${Math.round(stallMs / 1000)}s; giving up`);
      break;
    }
    await pause(pollMs);
    queued = count(cacheDir);
    if (queued < lowest) {
      lowest = queued;
      lastProgress = now();
    }
  }
  if (queued === 0) log(`Upload queue empty after ${Math.round((now() - start) / 1000)}s`);
  return queued;
}

module.exports = {
  SHIM_NAME,
  normalizePrefix,
  prefixesOverlap,
  resolveWriteMode,
  shellQuote,
  renderShim,
  writeShim,
  verifyWriteMode,
  countUploads,
  countSyncPushed,
  isPublishableMiss,
  failedDownloads,
  parseUploadCounters,
  uploadCheck,
  renderWriteCheckSummary,
  countQueuedUploads,
  waitForUploadQueue,
};
