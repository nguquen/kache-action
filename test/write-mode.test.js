// Fork-only (nguquen/kache-action): write modes that do not depend on branch
// protection. See src/write-mode.js.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  normalizePrefix,
  prefixesOverlap,
  resolveWriteMode,
  renderShim,
  writeShim,
  verifyWriteMode,
  countUploads,
  countSyncPushed,
  isPublishableMiss,
  uploadCheck,
  failedDownloads,
  parseUploadCounters,
  renderWriteCheckSummary,
  countQueuedUploads,
  waitForUploadQueue,
} = require("../src/write-mode");
const { renderRemoteConfigToml } = require("../src/utils");

const base = {
  trustedWriter: false,
  writePrefix: "",
  basePrefix: "kache/repo/master",
  s3: true,
  saveCache: true,
  platform: "linux",
  version: "v0.28.1",
};

test("no write-mode inputs keeps upstream behaviour", () => {
  assert.deepEqual(resolveWriteMode(base), {
    mode: "default",
    env: {},
    pullRequestPrefix: null,
  });
});

test("trusted-writer fakes a protected-branch push", () => {
  const mode = resolveWriteMode({ ...base, trustedWriter: true });
  assert.equal(mode.mode, "trusted");
  assert.deepEqual(mode.env, {
    GITHUB_EVENT_NAME: "push",
    GITHUB_REF_TYPE: "branch",
    GITHUB_REF_PROTECTED: "true",
  });
  assert.equal(mode.pullRequestPrefix, null);
});

test("write-prefix makes a pull request job with its own prefix", () => {
  const mode = resolveWriteMode({ ...base, writePrefix: "/kache/repo/branch/" });
  assert.equal(mode.mode, "prefix");
  assert.deepEqual(mode.env, { GITHUB_EVENT_NAME: "pull_request" });
  assert.equal(mode.pullRequestPrefix, "kache/repo/branch");
});

test("write modes reject invalid combinations", () => {
  assert.throws(
    () => resolveWriteMode({ ...base, trustedWriter: true, writePrefix: "x" }),
    /mutually exclusive/,
  );
  assert.throws(() => resolveWriteMode({ ...base, trustedWriter: true, s3: false }), /S3 remote/);
  assert.throws(
    () => resolveWriteMode({ ...base, writePrefix: "x", saveCache: false }),
    /save-cache: false/,
  );
  assert.throws(
    () => resolveWriteMode({ ...base, trustedWriter: true, platform: "win32" }),
    /Windows/,
  );
});

test("write-prefix may not overlap the base prefix", () => {
  for (const writePrefix of ["kache/repo/master", "kache/repo/master/pr", "kache/repo", "kache"]) {
    assert.throws(() => resolveWriteMode({ ...base, writePrefix }), /must differ/, writePrefix);
  }
  // A sibling that merely shares a string prefix is fine.
  assert.equal(resolveWriteMode({ ...base, writePrefix: "kache/repo/master-pr" }).mode, "prefix");
  assert.ok(prefixesOverlap("", "anything"));
  assert.equal(normalizePrefix("  /a/b/ "), "a/b");
  // Mode-first layout: one lifecycle rule on kache/branch/ covers every repo.
  for (const writePrefix of ["kache/branch/repo", "kache/release/repo"]) {
    assert.equal(
      resolveWriteMode({ ...base, basePrefix: "kache/master/repo", writePrefix }).mode,
      "prefix",
    );
  }
});

test("renderShim exports the overrides and execs the real binary", () => {
  const shim = renderShim("/opt/kache/0.28.1/kache", {
    GITHUB_REF_PROTECTED: "true",
    GITHUB_EVENT_NAME: "push",
  });
  assert.match(shim, /^#!\/bin\/sh\n/);
  assert.match(shim, /^export GITHUB_EVENT_NAME='push'$/m);
  assert.match(shim, /^export GITHUB_REF_PROTECTED='true'$/m);
  assert.match(shim, /^exec '\/opt\/kache\/0\.28\.1\/kache' "\$@"$/m);
});

test("the shim passes arguments through and overrides only kache's view", { skip: process.platform === "win32" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kache-shim-"));
  try {
    // A fake "real kache" that prints what it received.
    const fake = path.join(dir, "real kache");
    fs.writeFileSync(
      fake,
      '#!/bin/sh\nprintf "%s|%s|%s\\n" "$GITHUB_EVENT_NAME" "$GITHUB_REF_PROTECTED" "$*"\n',
      { mode: 0o755 },
    );
    const shim = writeShim(path.join(dir, "shim"), fake, {
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF_PROTECTED: "it's true",
    });
    assert.equal(path.basename(shim), "kache");
    const out = execFileSync(shim, ["rustc", "--crate-name", "a b"], {
      env: { PATH: process.env.PATH, GITHUB_EVENT_NAME: "pull_request" },
      encoding: "utf8",
    });
    assert.equal(out, "push|it's true|rustc --crate-name a b\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("renderRemoteConfigToml writes pull_request_prefix only when given", () => {
  const remote = { bucket: "b", region: "auto", prefix: "kache/repo/master", readonly: false };
  assert.doesNotMatch(renderRemoteConfigToml(remote), /pull_request_prefix/);
  assert.match(
    renderRemoteConfigToml({ ...remote, pullRequestPrefix: "kache/repo/branch" }),
    /^pull_request_prefix = "kache\/repo\/branch"$/m,
  );
});

test("verifyWriteMode reads doctor for trusted and the socket for prefix", () => {
  const doctor = (detail) => ({ checks: [{ label: "Remote writes", detail }] });
  assert.equal(verifyWriteMode("trusted", { doctor: doctor("read-write") }).ok, true);
  const readonly = verifyWriteMode("trusted", {
    doctor: doctor("read-only — GitHub Actions push (branch) is not a protected-branch push"),
  });
  assert.equal(readonly.ok, false);
  assert.match(readonly.detail, /read-only/);
  assert.equal(verifyWriteMode("trusted", { doctor: null }).ok, false);

  const status = (socket) => ({ socket });
  assert.equal(verifyWriteMode("prefix", { status: status("/tmp/r/daemon-pr-c7e0f186.sock") }).ok, true);
  assert.equal(verifyWriteMode("prefix", { status: status("/tmp/r/daemon.sock") }).ok, false);
  assert.equal(verifyWriteMode("prefix", { status: null }).ok, false);
  assert.equal(verifyWriteMode("default", {}).ok, true);
});

test("countUploads counts successful daemon upload events only", () => {
  const raw = [
    JSON.stringify({ direction: "upload", crate_name: "a", ok: true }),
    JSON.stringify({ direction: "upload", crate_name: "failed", ok: false }),
    JSON.stringify({ direction: "download", crate_name: "b" }),
    "not json",
    "",
    JSON.stringify({ direction: "upload", crate_name: "c" }),
  ].join("\n");
  assert.equal(countUploads(raw), 2);
  assert.equal(countUploads(""), 0);
});

test("countSyncPushed reads kache sync's plan line", () => {
  assert.equal(countSyncPushed("Plan: pull 0 artifacts, push 12 artifacts\n"), 12);
  assert.equal(countSyncPushed("Plan: pull 1 artifact, push 1 artifact"), 1);
  assert.equal(countSyncPushed("remote is read-only"), 0);
});

test("uploadCheck fails a writing job that compiled but published nothing", () => {
  const m = (...names) => names.map((name) => ({ name }));
  assert.equal(uploadCheck({ mode: "default", misses: m("a", "b"), uploads: 0, syncPushed: 0 }).ok, true);
  assert.equal(uploadCheck({ mode: "trusted", misses: [], uploads: 0, syncPushed: 0 }).ok, true);
  assert.equal(uploadCheck({ mode: "prefix", misses: m("a"), uploads: 0, syncPushed: 2 }).ok, true);
  const failed = uploadCheck({ mode: "trusted", misses: m("a", "b", "build_script_run"), uploads: 0, syncPushed: 0 });
  assert.equal(failed.ok, false);
  assert.match(failed.detail, /2 crate\(s\) compiled but nothing was uploaded/);
});

test("uploadCheck passes a crate recompiled after a failed download of an existing entry", () => {
  // The download of an entry already in the remote failed, kache compiled
  // it, and the daemon skipped the upload.
  const misses = [{ name: "my_crate", cache_key: "abc123def456" }];
  const check = uploadCheck({ mode: "prefix", misses, uploads: 0, syncPushed: 0, uploadsSkipped: 1 });
  assert.equal(check.ok, true);
});

test("uploadCheck still fails a real write stop", () => {
  // A read-only daemon returns before it counts a skip, so a new crate
  // compiled and nothing uploaded, pushed or skipped is a write stop.
  const misses = [{ name: "other_crate", cache_key: "def456abc123" }];
  const stopped = uploadCheck({ mode: "trusted", misses, uploads: 0, syncPushed: 0, uploadsSkipped: 0 });
  assert.equal(stopped.ok, false);
  assert.match(stopped.detail, /1 crate\(s\) compiled but nothing was uploaded in trusted write mode;/);
  // Missing counters (older kache, unreachable daemon) count as no skips.
  assert.equal(uploadCheck({ mode: "prefix", misses, uploads: 0, syncPushed: 0 }).ok, false);
  const failing = uploadCheck({ mode: "prefix", misses, uploads: 0, syncPushed: 0, uploadsFailed: 2, uploadsSuppressed: 1 });
  assert.equal(failing.ok, false);
  assert.match(failing.detail, /\(2 upload\(s\) failed, 1 suppressed by the write breaker\)/);
});

test("failedDownloads follows kache report's failed-download rule", () => {
  const raw = [
    JSON.stringify({ direction: "download", crate_name: "ok", cache_key: "k1", ok: true, elapsed_ms: 900 }),
    JSON.stringify({ direction: "download", crate_name: "my_crate", cache_key: "k2", ok: false, elapsed_ms: 2987 }),
    JSON.stringify({ direction: "download", crate_name: "gone", cache_key: "k3", ok: false, outcome: "not_found" }),
    JSON.stringify({ direction: "download", crate_name: "pf", cache_key: "k4", ok: false, outcome: "cancelled" }),
    JSON.stringify({ direction: "download", crate_name: "pf", cache_key: "k5", ok: false, outcome: "error", elapsed_ms: 12 }),
    JSON.stringify({ direction: "upload", crate_name: "up", cache_key: "k6", ok: false }),
    "not json",
  ].join("\n");
  assert.deepEqual(failedDownloads(raw), [
    { name: "my_crate", cacheKey: "k2", elapsedMs: 2987 },
    { name: "pf", cacheKey: "k5", elapsedMs: 12 },
  ]);
  assert.deepEqual(failedDownloads(""), []);
});

test("parseUploadCounters reads kache telemetry's upload sum by result", () => {
  // Shape of `kache telemetry write` (src/otel.rs, 0.28.1 and 2.1.1).
  const point = (result, value) => ({
    asInt: String(value),
    timeUnixNano: "1",
    startTimeUnixNano: "0",
    attributes: [{ key: "kache.cache.result", value: { stringValue: result } }],
  });
  const body = {
    resourceMetrics: [{
      resource: { attributes: [] },
      scopeMetrics: [{
        scope: { name: "kache.cache" },
        metrics: [
          { name: "kache.cache.store.max", gauge: { dataPoints: [{ asInt: "5" }] } },
          {
            name: "kache.cache.uploads",
            sum: {
              aggregationTemporality: "AGGREGATION_TEMPORALITY_CUMULATIVE",
              isMonotonic: true,
              dataPoints: [point("completed", 3), point("failed", 0), point("skipped", 1), point("suppressed", 2), point("toString", 9)],
            },
          },
        ],
      }],
    }],
  };
  assert.deepEqual(parseUploadCounters(JSON.stringify(body)), { completed: 3, failed: 0, skipped: 1, suppressed: 2 });
  assert.equal(parseUploadCounters(JSON.stringify({ resourceMetrics: [] })), null);
  assert.equal(parseUploadCounters("not json"), null);
  assert.equal(parseUploadCounters(""), null);
});

test("renderWriteCheckSummary names failed downloads and the compiled ones", () => {
  const misses = [{ name: "my_crate", cache_key: "abc123def4567890" }];
  const failed = [{ name: "my_crate", cacheKey: "abc123def4567890", elapsedMs: 2987 }];
  const counters = { completed: 0, failed: 0, skipped: 1, suppressed: 0 };
  const md = renderWriteCheckSummary({ mode: "prefix", misses, uploads: 0, syncPushed: 0, counters, failed, check: { ok: true } });
  assert.match(md, /kache write check \(prefix mode\): passed/);
  assert.match(md, /\| Upload skipped, already in the remote \| 1 \|/);
  assert.match(md, /\| `my_crate` \| `abc123def456` \| 2987ms \| compiled \|/);
  const unknown = renderWriteCheckSummary({ mode: "trusted", misses, uploads: 0, syncPushed: 0, counters: null, failed: [], check: { ok: false, detail: "boom" } });
  assert.match(unknown, /\| Upload skipped, already in the remote \| \? \|/);
  assert.match(unknown, /failed\n[\s\S]*boom\n$/);
});

test("uploadCheck ignores build-script misses, which kache never publishes", () => {
  const misses = [{ name: "build_script_build" }, { name: "build_script_run" }, { name: "build_script_run" }];
  assert.equal(uploadCheck({ mode: "trusted", misses, uploads: 0, syncPushed: 0 }).ok, true);
  assert.equal(isPublishableMiss("koki_media"), true);
  assert.equal(isPublishableMiss(undefined), true);
});

test("countQueuedUploads counts jobs in every upload-queue spool", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kache-spool-"));
  assert.equal(countQueuedUploads(dir), 0);
  fs.mkdirSync(path.join(dir, "upload-queue"));
  fs.mkdirSync(path.join(dir, "upload-queue-pr-1a2b3c4d"));
  fs.mkdirSync(path.join(dir, "store"));
  fs.writeFileSync(path.join(dir, "upload-queue", "a.json"), "{}");
  fs.writeFileSync(path.join(dir, "upload-queue", ".tmp-x"), "");
  fs.writeFileSync(path.join(dir, "upload-queue-pr-1a2b3c4d", "b.json"), "{}");
  fs.writeFileSync(path.join(dir, "upload-queue-pr-1a2b3c4d", "c.json"), "{}");
  fs.writeFileSync(path.join(dir, "store", "d.json"), "{}");
  assert.equal(countQueuedUploads(dir), 3);
  assert.equal(countQueuedUploads(path.join(dir, "missing")), 0);
});

function clockedWait(counts, opts) {
  let t = 0;
  const seq = [...counts];
  return waitForUploadQueue("/x", {
    pollMs: 1000,
    count: () => (seq.length > 1 ? seq.shift() : seq[0]),
    sleep: async (ms) => {
      t += ms;
    },
    now: () => t,
    ...opts,
  });
}

test("waitForUploadQueue returns once the spool drains", async () => {
  assert.equal(await clockedWait([5, 4, 2, 0], { timeoutMs: 60000 }), 0);
  assert.equal(await clockedWait([0], { timeoutMs: 1 }), 0);
});

test("waitForUploadQueue gives up on timeout or a stalled queue", async () => {
  assert.equal(await clockedWait([5, 4, 3, 3, 3, 3, 3, 3], { timeoutMs: 2000, stallMs: 60000 }), 3);
  const logs = [];
  const left = await clockedWait([5, 4, 4], { timeoutMs: 600000, stallMs: 3000, log: (m) => logs.push(m) });
  assert.equal(left, 4);
  assert.match(logs.at(-1), /stalled at 4/);
});

test("write modes require an explicit kache version", () => {
  for (const extra of [{ trustedWriter: true }, { writePrefix: "kache/repo/branch" }]) {
    for (const version of ["", "  ", undefined]) {
      assert.throws(() => resolveWriteMode({ ...base, ...extra, version }), /requires an explicit version/);
    }
  }
  assert.equal(resolveWriteMode({ ...base, version: "" }).mode, "default");
});
