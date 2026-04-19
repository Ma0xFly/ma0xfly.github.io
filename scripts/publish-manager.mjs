import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  computeNoteSyncFingerprint,
  collectPublishedPreview,
  getPublishedNotesWithChanges,
  loadLiveState,
  loadPublishingConfig,
  loadPublishState,
  readJsonUtf8File,
  readNoteMeta,
  saveLiveState,
  savePublishState,
  scanSourceNotes,
} from "./publishing-utils.mjs";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uiDir = path.join(rootDir, "manager-ui");
const siteConfig = await readJsonUtf8File(path.join(rootDir, "src", "config", "site.json"), "site config");
const host = "127.0.0.1";
const port = 3210;
const apiVersion = 3;
const sessionTtlMs = 15 * 60 * 1000;
let managerSession = createManagerSession();
const requiredCapabilities = [
  "build",
  "check",
  "deploy",
  "publish-and-deploy",
  "update-published",
  "sync-status",
  "live-check",
  "auth-token",
];
const distDir = path.join(rootDir, "dist");
const distGitDir = path.join(distDir, ".git");
const distIndexLock = path.join(distGitDir, "index.lock");
const deployMarkerPath = path.join(distDir, "deploy-version.json");

let actionQueue = Promise.resolve();

const server = createServer(async (req, res) => {
  try {
    if (!req.url) {
      return respondJson(res, 404, { error: "Not found" });
    }

    const url = new URL(req.url, `http://${host}:${port}`);

    if (req.method === "GET" && url.pathname === "/api/notes") {
      assertAuthorizedRequest(req, url);
      const payload = await buildNotesPayload();
      return respondJson(res, 200, payload);
    }

    if (req.method === "GET" && url.pathname === "/api/meta") {
      return respondJson(res, 200, {
        ok: true,
        apiVersion,
        capabilities: requiredCapabilities,
      });
    }

    if (req.method === "POST" && url.pathname === "/api/state") {
      assertAuthorizedRequest(req, url);
      const body = await readJsonBody(req);
      const config = await loadPublishingConfig();
      const notePaths = await scanSourceNotes(config);
      const currentState = await loadPublishState(config, notePaths);
      await savePublishState(mergeDraftNotesIntoState(currentState, body.notes ?? {}));
      return respondJson(res, 200, {
        ok: true,
        message: "Draft state saved. Changes are pending deploy until live verification succeeds.",
      });
    }

    if (req.method === "POST" && url.pathname === "/api/preview") {
      assertAuthorizedRequest(req, url);
      const body = await readJsonBody(req);
      const config = await loadPublishingConfig();
      const preview = await collectPublishedPreview(config, body.notes ?? {});
      return respondJson(res, 200, { ok: true, preview });
    }

    if (req.method === "GET" && url.pathname === "/api/sync-status") {
      assertAuthorizedRequest(req, url);
      const payload = await buildSyncStatusPayload();
      return respondJson(res, 200, payload);
    }

    if (req.method === "GET" && url.pathname === "/api/live-check") {
      assertAuthorizedRequest(req, url);
      const token = url.searchParams.get("token") ?? "";
      const payload = await checkLiveDeploymentToken(token);
      return respondJson(res, 200, payload);
    }

    if (req.method === "POST" && url.pathname === "/api/actions/build") {
      assertAuthorizedRequest(req, url);
      const result = await enqueueAction("build", async () => runNpmScript("build"));
      return respondJson(res, 200, result);
    }

    if (req.method === "POST" && url.pathname === "/api/actions/check") {
      assertAuthorizedRequest(req, url);
      const result = await enqueueAction("check", async () => runNpmScript("check"));
      return respondJson(res, 200, result);
    }

    if (req.method === "POST" && url.pathname === "/api/actions/deploy") {
      assertAuthorizedRequest(req, url);
      const result = await enqueueAction("deploy", async () => deployCurrentDraft());
      return respondJson(res, 200, result);
    }

    if (req.method === "POST" && url.pathname === "/api/actions/update-published") {
      assertAuthorizedRequest(req, url);
      const result = await enqueueAction("update-published", async () => updatePublishedChanges());
      return respondJson(res, 200, result);
    }

    if (req.method === "POST" && url.pathname === "/api/actions/publish-and-deploy") {
      assertAuthorizedRequest(req, url);
      const body = await readJsonBody(req);
      const result = await enqueueAction("publish-and-deploy", async () => publishAndDeploy(body));
      return respondJson(res, 200, result);
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return respondIndexHtml(res);
    }

    if (req.method === "GET" && url.pathname === "/app.js") {
      return respondFile(res, path.join(uiDir, "app.js"), "text/javascript; charset=utf-8");
    }

    if (req.method === "GET" && url.pathname === "/styles.css") {
      return respondFile(res, path.join(uiDir, "styles.css"), "text/css; charset=utf-8");
    }

    return respondJson(res, 404, { error: "Not found" });
  } catch (error) {
    return respondJson(res, error?.statusCode ?? 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(port, host, async () => {
  const managerUrl = `http://${host}:${port}/`;
  console.log(`Publish manager running at ${managerUrl}`);
  try {
    await execFileAsync("cmd.exe", ["/c", "start", "", managerUrl], { cwd: rootDir });
  } catch {}
});

function enqueueAction(label, task) {
  const run = actionQueue.then(async () => task());
  actionQueue = run.catch(() => undefined);

  return run.catch((error) => ({
    ok: false,
    stdout: "",
    stderr: "",
    error: `${label} failed: ${error instanceof Error ? error.message : String(error)}`,
  }));
}

function assertAuthorizedRequest(req, url) {
  if (Date.now() > managerSession.expiresAt) {
    managerSession = createManagerSession();
    const error = new Error("Session expired. Reload the publishing desk to continue.");
    error.statusCode = 401;
    throw error;
  }

  const providedToken = readManagerSessionToken(req);
  if (providedToken !== managerSession.token) {
    const error = new Error(`Unauthorized request for ${url.pathname}`);
    error.statusCode = 403;
    throw error;
  }

  if (req.method !== "GET") {
    const origin = req.headers.origin;
    const referer = req.headers.referer;
    const expectedOrigin = `http://${host}:${port}`;

    if (origin && origin !== expectedOrigin) {
      const error = new Error(`Rejected request from unexpected origin: ${origin}`);
      error.statusCode = 403;
      throw error;
    }

    if (referer && !referer.startsWith(expectedOrigin)) {
      const error = new Error(`Rejected request from unexpected referer: ${referer}`);
      error.statusCode = 403;
      throw error;
    }
  }
}

async function buildNotesPayload() {
  const config = await loadPublishingConfig();
  const notePaths = await scanSourceNotes(config);
  const draftState = await loadPublishState(config, notePaths);
  const liveState = await loadLiveState(config, notePaths);
  const notes = await Promise.all(
    notePaths.map(async (relativePath) => {
      const meta = await readNoteMeta(config, relativePath);
      const draftPublish = draftState.notes?.[relativePath]?.publish === true;
      const livePublish = liveState.notes?.[relativePath]?.publish === true;
      const draftCustomTags = normalizeTagList(draftState.notes?.[relativePath]?.customTags);
      const liveCustomTags = normalizeTagList(liveState.notes?.[relativePath]?.customTags);
      const autoTags = getDirectoryTags(relativePath);
      const sourceTags = normalizeTagList(meta.tags);
      const mergedTags = mergeTags(sourceTags, autoTags, draftCustomTags);
      return {
        ...meta,
        tags: mergedTags,
        sourceTags,
        autoTags,
        draftCustomTags,
        liveCustomTags,
        publish: draftPublish,
        draftPublish,
        livePublish,
        pendingDeploy: draftPublish !== livePublish || !isSameTagList(draftCustomTags, liveCustomTags),
      };
    }),
  );

  const draftPublishedCount = notes.filter((note) => note.draftPublish).length;
  const livePublishedCount = notes.filter((note) => note.livePublish).length;
  const pendingCount = notes.filter((note) => note.pendingDeploy).length;

  return {
    sourceRoot: config.sourceRoot,
    noteCount: notes.length,
    publishedCount: livePublishedCount,
    draftPublishedCount,
    livePublishedCount,
    pendingCount,
    notes,
    state: draftState.notes,
    draftState: draftState.notes,
    liveState: liveState.notes,
  };
}

async function buildSyncStatusPayload() {
  const config = await loadPublishingConfig();
  const notePaths = await scanSourceNotes(config);
  const draftState = await loadPublishState(config, notePaths);
  const liveState = await loadLiveState(config, notePaths);
  const changedNotes = await getPublishedNotesWithChanges(config, liveState, notePaths);
  const publishedEntries = Object.entries(liveState.notes ?? {}).filter(([, value]) => value?.publish === true);
  const pendingCount = notePaths.filter((relativePath) => {
    const draftPublish = draftState.notes?.[relativePath]?.publish === true;
    const livePublish = liveState.notes?.[relativePath]?.publish === true;
    return draftPublish !== livePublish;
  }).length;
  const lastSyncedAt = publishedEntries
    .map(([, value]) => value?.syncedAt)
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;

  return {
    ok: true,
    publishedCount: publishedEntries.length,
    changedCount: changedNotes.length,
    changedPaths: changedNotes.map((item) => item.relativePath),
    pendingCount,
    lastSyncedAt,
  };
}

async function publishAndDeploy(body) {
  const config = await loadPublishingConfig();
  const notePaths = await scanSourceNotes(config);
  const currentState = await loadPublishState(config, notePaths);
  const liveStateBefore = await loadLiveState(config, notePaths);
  const nextState = mergeDraftNotesIntoState(currentState, body.notes ?? {});
  const selectedPaths = Array.isArray(body.selectedPaths) ? body.selectedPaths.map(String) : [];
  const beforeState = await buildNotesPayload();

  await savePublishState(nextState);
  await syncDistMainBeforeBuild();

  const buildResult = await runNpmScript("build");
  if (!buildResult.ok) {
    return buildResult;
  }

  const deployResult = await deployDist({
    previousLiveState: liveStateBefore,
    reason: "publish-and-deploy",
  });
  if (!deployResult.ok) {
    return deployResult;
  }

  const publishedUrls = selectedPaths
    .filter((relativePath) => nextState.notes?.[relativePath]?.publish === true)
    .map((relativePath) => `${siteConfig.siteUrl}${toPublicPostPath(relativePath)}`);
  const newlyPublishedUrls = selectedPaths
    .filter((relativePath) => {
      const before = beforeState.state?.[relativePath]?.publish === true;
      const after = nextState.notes?.[relativePath]?.publish === true;
      return !before && after;
    })
    .map((relativePath) => `${siteConfig.siteUrl}${toPublicPostPath(relativePath)}`);

  return {
    ok: true,
    stdout: [buildResult.stdout, deployResult.stdout].filter(Boolean).join("\n").trim(),
    stderr: [buildResult.stderr, deployResult.stderr].filter(Boolean).join("\n").trim(),
    publishedUrls,
    newlyPublishedUrls,
    liveVerified: deployResult.liveVerified ?? null,
    liveContentVerified: deployResult.liveContentVerified ?? null,
    liveValidationSummary: deployResult.liveValidationSummary ?? null,
    liveUrl: deployResult.liveUrl ?? null,
    liveToken: deployResult.liveToken ?? null,
  };
}

async function deployCurrentDraft() {
  const config = await loadPublishingConfig();
  const notePaths = await scanSourceNotes(config);
  const previousLiveState = await loadLiveState(config, notePaths);
  await syncDistMainBeforeBuild();

  const buildResult = await runNpmScript("build");
  if (!buildResult.ok) {
    return buildResult;
  }

  const deployResult = await deployDist({
    previousLiveState,
    reason: "deploy",
  });

  return {
    ok: true,
    changed: true,
    stdout: [buildResult.stdout, deployResult.stdout].filter(Boolean).join("\n").trim(),
    stderr: [buildResult.stderr, deployResult.stderr].filter(Boolean).join("\n").trim(),
    liveVerified: deployResult.liveVerified ?? null,
    liveContentVerified: deployResult.liveContentVerified ?? null,
    liveValidationSummary: deployResult.liveValidationSummary ?? null,
    liveUrl: deployResult.liveUrl ?? null,
    liveToken: deployResult.liveToken ?? null,
  };
}

async function deployDist(options = {}) {
  const { previousLiveState = null, reason = "deploy" } = options;
  await ensureDistRepo(distDir);
  await cleanupDistLock();
  const deployMarker = await writeDeployMarker();

  await runGit(["add", "-A"]);

  const commitMessage = `Deploy content ${new Date().toISOString()}`;
  const commitResult = await runGit(["commit", "-m", commitMessage], {
    allowFailure: true,
  });

  const commitOutput = `${commitResult.stdout}\n${commitResult.stderr}`;
  if (!commitResult.ok && !/nothing to commit|working tree clean/i.test(commitOutput)) {
    throw new Error(`git commit failed:\n${commitOutput.trim()}`);
  }

  const localHead = (await runGit(["rev-parse", "HEAD"])).stdout.trim();
  const pushResult = await runGit(["push", "origin", "main"], { retries: 3 });
  const remoteHead = await resolveRemoteHeadWithFallback();
  const remoteVerificationMessage = remoteHead
    ? `Verified remote HEAD: ${remoteHead}`
    : "Warning: remote HEAD could not be verified (ls-remote/fetch unavailable), but push command succeeded.";

  if (remoteHead && remoteHead !== localHead) {
    throw new Error(`Push verification failed. Local HEAD ${localHead} does not match remote HEAD ${remoteHead}.`);
  }

  const liveValidationPlan = await buildLiveValidationPlan(previousLiveState);
  const liveResult = await waitForLiveDeployment(deployMarker.token, {
    validationPlan: liveValidationPlan,
  });
  if (liveResult.ok && liveResult.contentVerified !== false) {
    await syncLiveStateFromGeneratedOutput();
  }

  return {
    ok: true,
    changed: true,
    stdout: [commitResult.stdout, pushResult.stdout, remoteVerificationMessage, liveResult.message]
      .filter(Boolean)
      .join("\n")
      .trim(),
    stderr: [commitResult.stderr, pushResult.stderr].filter(Boolean).join("\n").trim(),
    liveVerified: liveResult.ok,
    liveContentVerified: liveResult.contentVerified ?? null,
    liveValidationSummary: liveResult.contentMessage ?? null,
    reason,
    liveUrl: `${siteConfig.siteUrl}/deploy-version.json`,
    liveToken: deployMarker.token,
  };
}

async function updatePublishedChanges() {
  const config = await loadPublishingConfig();
  const notePaths = await scanSourceNotes(config);
  const liveState = await loadLiveState(config, notePaths);
  const draftState = await loadPublishState(config, notePaths);
  const changedNotes = await getPublishedNotesWithChanges(config, liveState, notePaths);
  const pendingCount = notePaths.filter((relativePath) => {
    const draftPublish = draftState.notes?.[relativePath]?.publish === true;
    const livePublish = liveState.notes?.[relativePath]?.publish === true;
    return draftPublish !== livePublish;
  }).length;

  if (pendingCount > 0) {
    return {
      ok: false,
      changed: false,
      changedCount: 0,
      changedPaths: [],
      stdout: "",
      stderr: "",
      error: `Detected ${pendingCount} pending draft changes. Deploy or revert draft/live differences before syncing live content changes.`,
    };
  }

  if (changedNotes.length === 0) {
    return {
      ok: true,
      changed: false,
      changedCount: 0,
      changedPaths: [],
      stdout: "No modified published notes were detected.",
      stderr: "",
    };
  }

  await syncDistMainBeforeBuild();

  const buildResult = await runNpmScript("build");
  if (!buildResult.ok) {
    return buildResult;
  }

  const deployResult = await deployDist({
    previousLiveState: liveState,
    reason: "update-published",
  });
  if (!deployResult.ok) {
    return deployResult;
  }

  return {
    ok: true,
    changed: true,
    changedCount: changedNotes.length,
    changedPaths: changedNotes.map((item) => item.relativePath),
    stdout: [
      `Detected ${changedNotes.length} modified published notes.`,
      ...changedNotes.map((item) => item.relativePath),
      buildResult.stdout,
      deployResult.stdout,
    ].filter(Boolean).join("\n").trim(),
    stderr: [buildResult.stderr, deployResult.stderr].filter(Boolean).join("\n").trim(),
    liveVerified: deployResult.liveVerified ?? null,
    liveContentVerified: deployResult.liveContentVerified ?? null,
    liveValidationSummary: deployResult.liveValidationSummary ?? null,
    liveUrl: deployResult.liveUrl ?? null,
    liveToken: deployResult.liveToken ?? null,
  };
}

async function syncLiveStateFromGeneratedOutput(timestamp = new Date().toISOString()) {
  const config = await loadPublishingConfig();
  const notePaths = await scanSourceNotes(config);
  const liveState = await loadLiveState(config, notePaths);
  const draftState = await loadPublishState(config, notePaths);
  const publishedManifest = await readPublishedManifest();
  const liveSourceSet = new Set(
    (publishedManifest.publishedPosts ?? [])
      .map((item) => item?.sourcePath)
      .filter((value) => typeof value === "string" && value.trim())
      .map((value) => value.replace(/\\/g, "/")),
  );

  const notes = { ...(liveState.notes ?? {}) };
  for (const relativePath of notePaths) {
    const previously = notes[relativePath] && typeof notes[relativePath] === "object"
      ? notes[relativePath]
      : { publish: false, syncedHash: null, syncedAt: null };
    const shouldPublishLive = liveSourceSet.has(relativePath);

    if (!shouldPublishLive) {
      notes[relativePath] = {
        ...previously,
        publish: false,
        syncedHash: null,
        syncedAt: null,
        customTags: normalizeTagList(draftState.notes?.[relativePath]?.customTags),
      };
      continue;
    }

    notes[relativePath] = {
      ...previously,
      publish: true,
      syncedHash: await computeNoteSyncFingerprint(config, relativePath),
      syncedAt: timestamp,
      customTags: normalizeTagList(draftState.notes?.[relativePath]?.customTags),
    };
  }

  await saveLiveState({ notes });
}

async function writeDeployMarker() {
  const token = `${Date.now()}-${randomUUID()}`;
  const payload = {
    token,
    deployedAt: new Date().toISOString(),
  };

  await writeFile(deployMarkerPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

async function waitForLiveDeployment(expectedToken, options = {}) {
  const { timeoutMs = 120000, intervalMs = 4000, validationPlan = null } = options;
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    const status = await checkLiveDeploymentToken(expectedToken);
    if (status.liveVerified) {
      const contentStatus = validationPlan
        ? await validateLiveContentConsistency(validationPlan)
        : { ok: true, message: "Content checks skipped." };
      return {
        ok: contentStatus.ok,
        contentVerified: contentStatus.ok,
        contentMessage: contentStatus.message,
        message: contentStatus.ok
          ? `Verified live deployment at ${status.liveUrl}. ${contentStatus.message}`
          : `Live deploy marker updated, but content validation failed. ${contentStatus.message}`,
      };
    }

    await sleep(intervalMs);
  }

  return {
    ok: false,
    contentVerified: false,
    contentMessage: "Timed out before content checks could be completed.",
    message: `Timed out waiting for live deployment at ${siteConfig.siteUrl}/deploy-version.json`,
  };
}

async function buildLiveValidationPlan(previousLiveState) {
  const previousPublished = new Set(
    Object.entries(previousLiveState?.notes ?? {})
      .filter(([, value]) => value?.publish === true)
      .map(([relativePath]) => relativePath),
  );
  const publishedManifest = await readPublishedManifest();
  const nextPublished = new Set(
    (publishedManifest.publishedPosts ?? [])
      .map((item) => item?.sourcePath)
      .filter((value) => typeof value === "string" && value.trim())
      .map((value) => value.replace(/\\/g, "/")),
  );

  const unpublishedPaths = [...previousPublished].filter((relativePath) => !nextPublished.has(relativePath));
  const samplePublishedPaths = [...nextPublished].slice(0, 5);

  return {
    unpublishedPaths,
    samplePublishedPaths,
  };
}

async function validateLiveContentConsistency(plan) {
  const failures = [];
  const unpublishedSamples = plan.unpublishedPaths.slice(0, 8);
  const publishedSamples = plan.samplePublishedPaths.slice(0, 5);

  for (const relativePath of unpublishedSamples) {
    const postUrl = `${siteConfig.siteUrl}${toPublicPostPath(relativePath)}`;
    const result = await fetchLiveStatus(postUrl);
    if (![404, 410].includes(result.status)) {
      failures.push(`Expected 404/410 for unpublished post ${relativePath}, got ${result.status} (${postUrl})`);
    }
  }

  for (const relativePath of publishedSamples) {
    const postUrl = `${siteConfig.siteUrl}${toPublicPostPath(relativePath)}`;
    const result = await fetchLiveStatus(postUrl);
    if (result.status >= 400) {
      failures.push(`Expected published post to be reachable for ${relativePath}, got ${result.status} (${postUrl})`);
    }
  }

  if (unpublishedSamples.length > 0) {
    const homeUrl = `${siteConfig.siteUrl}/`;
    const home = await fetchLiveText(homeUrl);
    if (home.status >= 400) {
      failures.push(`Failed to fetch homepage for index validation: ${home.status} (${homeUrl})`);
    } else {
      for (const relativePath of unpublishedSamples.slice(0, 5)) {
        const publicPath = toPublicPostPath(relativePath);
        if (home.text.includes(publicPath)) {
          failures.push(`Unpublished path still appears on homepage index: ${publicPath}`);
        }
      }
    }
  }

  if (failures.length > 0) {
    return {
      ok: false,
      message: failures.join(" | "),
    };
  }

  return {
    ok: true,
    message: `Content checks passed (unpublished samples=${unpublishedSamples.length}, published samples=${publishedSamples.length}).`,
  };
}

async function readPublishedManifest() {
  return readJsonUtf8File(path.join(rootDir, "src", "generated", "published-manifest.json"), "published manifest");
}

async function fetchLiveStatus(url) {
  try {
    const response = await fetch(url, {
      headers: { "Cache-Control": "no-cache" },
      redirect: "manual",
    });
    return {
      status: response.status,
    };
  } catch {
    return {
      status: 599,
    };
  }
}

async function fetchLiveText(url) {
  try {
    const response = await fetch(url, {
      headers: { "Cache-Control": "no-cache" },
    });
    const text = await response.text();
    return {
      status: response.status,
      text,
    };
  } catch {
    return {
      status: 599,
      text: "",
    };
  }
}

async function checkLiveDeploymentToken(expectedToken) {
  const liveUrl = `${siteConfig.siteUrl}/deploy-version.json`;

  try {
    const response = await fetch(liveUrl, {
      headers: { "Cache-Control": "no-cache" },
    });

    if (!response.ok) {
      return {
        ok: true,
        liveVerified: false,
        liveUrl,
        expectedToken,
        currentToken: null,
      };
    }

    const payload = await response.json();
    return {
      ok: true,
      liveVerified: payload?.token === expectedToken,
      liveUrl,
      expectedToken,
      currentToken: payload?.token ?? null,
      deployedAt: payload?.deployedAt ?? null,
    };
  } catch {
    return {
      ok: true,
      liveVerified: false,
      liveUrl,
      expectedToken,
      currentToken: null,
    };
  }
}

async function ensureDistRepo(targetDistDir) {
  const repoCheck = await runCommand("git", ["-C", targetDistDir, "rev-parse", "--is-inside-work-tree"], rootDir, {
    allowFailure: true,
  });

  if (!repoCheck.ok) {
    await runCommand("git", ["init", "-b", "main", targetDistDir], rootDir);
    await runCommand("git", ["-C", targetDistDir, "config", "user.name", "mayuxiang"], rootDir);
    await runCommand("git", ["-C", targetDistDir, "config", "user.email", "2651234683@qq.com"], rootDir);
  }

  const remoteCheck = await runCommand("git", ["-C", targetDistDir, "remote", "get-url", "origin"], rootDir, {
    allowFailure: true,
  });

  if (!remoteCheck.ok) {
    await runCommand(
      "git",
      ["-C", targetDistDir, "remote", "add", "origin", "https://github.com/Ma0xFly/ma0xfly.github.io.git"],
      rootDir,
    );
  }

  try {
    await readFile(path.join(targetDistDir, ".nojekyll"));
  } catch {
    await writeFile(path.join(targetDistDir, ".nojekyll"), "", "ascii");
  }
}

async function syncDistMainBeforeBuild() {
  await ensureDistRepo(distDir);
  await cleanupDistLock();

  await runGit(["checkout", "main"], {
    allowFailure: true,
    retries: 0,
  });

  const dirtyStatus = await runGit(["status", "--porcelain"], {
    allowFailure: true,
    retries: 0,
  });
  if (dirtyStatus.ok && dirtyStatus.stdout.trim()) {
    throw new Error("dist working tree is not clean before build. Please commit or discard local dist changes first.");
  }

  const fetchResult = await runGit(["fetch", "origin", "main"], {
    allowFailure: true,
    retries: 1,
  });
  if (!fetchResult.ok) {
    return;
  }

  const hasRemoteMain = await runGit(["rev-parse", "--verify", "refs/remotes/origin/main"], {
    allowFailure: true,
    retries: 0,
  });
  if (!hasRemoteMain.ok) {
    return;
  }

  const pullResult = await runGit(["pull", "--rebase", "origin", "main"], {
    allowFailure: true,
    retries: 0,
  });
  if (!pullResult.ok) {
    const output = `${pullResult.stdout}\n${pullResult.stderr}`.trim();
    throw new Error(`git pull --rebase origin main failed before build:\n${output}`);
  }
}

async function runNpmScript(scriptName) {
  return runCommand("cmd.exe", ["/c", "npm", "run", scriptName], rootDir, {
    maxBuffer: 32 * 1024 * 1024,
  });
}

async function runGit(args, options = {}) {
  const { retries = 2, allowFailure = false } = options;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const result = await runCommand("git", ["-C", distDir, ...args], rootDir, {
      allowFailure: true,
      maxBuffer: 32 * 1024 * 1024,
    });

    if (result.ok) {
      return result;
    }

    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    if (/index\.lock|another git process|could not lock/i.test(combinedOutput)) {
      await cleanupDistLock();
      if (attempt < retries) {
        continue;
      }
    }

    if (allowFailure) {
      return result;
    }

    throw new Error(`git ${args.join(" ")} failed:\n${combinedOutput.trim()}`);
  }

  throw new Error(`git ${args.join(" ")} failed after ${retries + 1} attempts.`);
}

async function cleanupDistLock() {
  await rm(distIndexLock, { force: true });
}

async function readRemoteHead() {
  const result = await runGit(["ls-remote", "origin", "refs/heads/main"], {
    retries: 1,
    allowFailure: true,
  });

  if (!result.ok || !result.stdout.trim()) {
    return "";
  }

  return result.stdout.trim().split(/\s+/)[0] ?? "";
}

async function resolveRemoteHeadWithFallback() {
  const directRemoteHead = await readRemoteHead();
  if (directRemoteHead) {
    return directRemoteHead;
  }

  const fetchResult = await runGit(["fetch", "origin", "main"], {
    retries: 1,
    allowFailure: true,
  });

  if (!fetchResult.ok) {
    return "";
  }

  const originMain = await runGit(["rev-parse", "refs/remotes/origin/main"], {
    retries: 1,
    allowFailure: true,
  });

  if (!originMain.ok) {
    return "";
  }

  return originMain.stdout.trim();
}

async function runCommand(command, args, cwd, options = {}) {
  const {
    allowFailure = false,
    maxBuffer = 20 * 1024 * 1024,
  } = options;

  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      windowsHide: true,
      maxBuffer,
    });
    return {
      ok: true,
      stdout,
      stderr,
    };
  } catch (error) {
    const stdout = error?.stdout ?? "";
    const stderr = error?.stderr ?? "";

    if (allowFailure) {
      return {
        ok: false,
        stdout,
        stderr,
      };
    }

    const reason = error instanceof Error ? error.message : String(error);
    throw new Error([reason, stdout, stderr].filter(Boolean).join("\n").trim());
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function respondFile(res, targetPath, contentType) {
  const content = await readFile(targetPath);
  res.writeHead(200, { "Content-Type": contentType });
  res.end(content);
}

async function respondIndexHtml(res) {
  managerSession = createManagerSession();
  const html = await readFile(path.join(uiDir, "index.html"), "utf8");
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Set-Cookie": `publishing_desk_session=${managerSession.token}; Max-Age=${Math.floor(sessionTtlMs / 1000)}; HttpOnly; SameSite=Strict; Path=/`,
    "Cache-Control": "no-store",
  });
  res.end(html);
}

function respondJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function mergeDraftNotesIntoState(currentState, draftNotes) {
  const nextNotes = { ...(currentState.notes ?? {}) };

  for (const [relativePath, draftEntry] of Object.entries(draftNotes ?? {})) {
    const previous = nextNotes[relativePath] && typeof nextNotes[relativePath] === "object"
      ? nextNotes[relativePath]
      : {};

    nextNotes[relativePath] = {
      publish: draftEntry?.publish === true,
      syncedHash: previous.syncedHash ?? null,
      syncedAt: previous.syncedAt ?? null,
      customTags: normalizeTagList(draftEntry?.customTags ?? previous.customTags),
    };
  }

  return { notes: nextNotes };
}

function createManagerSession() {
  return {
    token: randomUUID(),
    expiresAt: Date.now() + sessionTtlMs,
  };
}

function getDirectoryTags(relativePath) {
  const directory = relativePath.includes("/") ? relativePath.slice(0, relativePath.lastIndexOf("/")) : "";
  if (!directory || directory === ".") return [];
  return normalizeTagList(directory.split("/").map((segment) => segment.trim()));
}

function normalizeTagList(value) {
  if (!Array.isArray(value)) return [];

  const seen = new Set();
  const tags = [];
  for (const item of value) {
    const tag = String(item ?? "").trim();
    if (!tag) continue;
    const key = tag.toLocaleLowerCase("zh-CN");
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags;
}

function mergeTags(...groups) {
  return normalizeTagList(groups.flatMap((group) => group ?? []));
}

function isSameTagList(left, right) {
  const leftNorm = normalizeTagList(left);
  const rightNorm = normalizeTagList(right);
  if (leftNorm.length !== rightNorm.length) return false;
  return leftNorm.every((tag, index) => tag === rightNorm[index]);
}

function readManagerSessionToken(req) {
  const cookieHeader = req.headers.cookie ?? "";
  const tokenFromCookie = cookieHeader
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith("publishing_desk_session="))
    ?.split("=")
    .slice(1)
    .join("=") ?? "";

  return tokenFromCookie || req.headers["x-manager-token"] || "";
}

function toPublicPostPath(relativePath) {
  return `/posts/${relativePath.replace(/\.[^.]+$/, "").replace(/\\/g, "/")}/`;
}
