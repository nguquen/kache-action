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

/** Count daemon uploads in kache's transfers.jsonl content. */
function countUploads(rawTransfers) {
  let uploads = 0;
  for (const line of String(rawTransfers || "").split("\n")) {
    if (!line.trim()) continue;
    try {
      if (JSON.parse(line).direction === "upload") uploads++;
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

/** A writing job that compiled something but published nothing means kache
 *  stopped honouring the mode, which would otherwise read as a cold cache. */
function uploadCheck({ mode, misses, uploads, syncPushed }) {
  if (mode === "default" || !misses) return { ok: true };
  if (uploads + syncPushed > 0) return { ok: true };
  return {
    ok: false,
    detail:
      `${misses} crate(s) compiled but nothing was uploaded in ${mode} write mode; ` +
      "kache may have changed how it decides remote writes",
  };
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
  uploadCheck,
  countQueuedUploads,
  waitForUploadQueue,
};
