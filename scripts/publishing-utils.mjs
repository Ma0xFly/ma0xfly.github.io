import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fg from "fast-glob";
import matter from "gray-matter";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configDir = path.join(rootDir, "config");
const configPath = path.join(configDir, "publishing.json");
const statePath = path.join(configDir, "publish-state.json");
const liveStatePath = path.join(configDir, "live-state.json");
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const mojibakeChecks = [
  { pattern: /\uFFFD/, message: 'contains replacement character "�"' },
  { pattern: /锟斤拷/, message: 'contains mojibake marker "锟斤拷"' },
];

export async function readUtf8TextFile(targetPath, label = "file") {
  const raw = await readFile(targetPath);
  let text;

  try {
    text = utf8Decoder.decode(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not valid UTF-8: ${targetPath}\n${reason}`);
  }

  return text.replace(/^\uFEFF/, "");
}

export async function readJsonUtf8File(targetPath, label = "JSON file") {
  const raw = await readUtf8TextFile(targetPath, label);

  try {
    return JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not valid JSON: ${targetPath}\n${reason}`);
  }
}

export function findTextCorruptionIssues(value) {
  if (typeof value !== "string" || !value) return [];

  const issues = [];
  for (const check of mojibakeChecks) {
    if (check.pattern.test(value)) {
      issues.push(check.message);
    }
  }

  return issues;
}

export async function loadPublishingConfig() {
  const parsed = await readJsonUtf8File(configPath, "publishing config");
  return {
    sourceRoot: normalizeAbsolutePath(parsed.sourceRoot),
    sharedGalleryDirs: ensureStringArray(parsed.sharedGalleryDirs),
    excludeDirs: ensureStringArray(parsed.excludeDirs),
    legacyPublishedRoots: ensureStringArray(parsed.legacyPublishedRoots),
  };
}

export async function scanSourceNotes(config) {
  const markdownFiles = await fg("**/*.{md,mdx}", {
    cwd: config.sourceRoot,
    onlyFiles: true,
    dot: false,
    ignore: config.excludeDirs.map((name) => `**/${name}/**`),
  });

  return markdownFiles
    .map(toPosix)
    .filter((relativePath) => !isTemplateMarkdown(relativePath))
    .sort((left, right) => left.localeCompare(right, "zh-CN"));
}

export async function loadPublishState(config, notePaths) {
  return loadStateFile(statePath, config, notePaths, { useLegacyDefault: true });
}

export async function loadLiveState(config, notePaths) {
  return loadStateFile(liveStatePath, config, notePaths, { useLegacyDefault: false });
}

async function loadStateFile(targetPath, config, notePaths, options) {
  await mkdir(configDir, { recursive: true });

  let currentState = { notes: {} };
  let stateExists = false;

  try {
    currentState = await readJsonUtf8File(
      targetPath,
      targetPath === liveStatePath ? "live state" : "publish state",
    );
    stateExists = true;
  } catch (error) {
    if (isEnoentError(error)) {
      currentState = { notes: {} };
    } else {
      throw error;
    }
  }

  const notes = currentState.notes && typeof currentState.notes === "object"
    ? currentState.notes
    : {};

  let changed = false;

  for (const relativePath of notePaths) {
    const existingEntry = normalizeStateEntry(notes[relativePath]);
    if (!existingEntry) {
      notes[relativePath] = {
        publish: stateExists
          ? false
          : (options.useLegacyDefault ? isLegacyPublished(relativePath, config.legacyPublishedRoots) : false),
        syncedHash: null,
        syncedAt: null,
      };
      changed = true;
      continue;
    }

    if (!isSameStateEntry(existingEntry, notes[relativePath])) {
      notes[relativePath] = existingEntry;
      changed = true;
    }
  }

  for (const relativePath of Object.keys(notes)) {
    if (!notePaths.includes(relativePath)) {
      delete notes[relativePath];
      changed = true;
    }
  }

  const normalizedState = { notes };

  if (!stateExists || changed) {
    await saveStateFile(targetPath, normalizedState);
  }

  return normalizedState;
}

export async function savePublishState(state) {
  await saveStateFile(statePath, state);
}

export async function saveLiveState(state) {
  await saveStateFile(liveStatePath, state);
}

async function saveStateFile(targetPath, state) {
  await mkdir(configDir, { recursive: true });
  await writeFile(targetPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function readNoteMeta(config, relativePath) {
  const { absolutePath, parsed } = await readNoteDocument(config, relativePath);
  const title =
    typeof parsed.data?.title === "string" && parsed.data.title.trim()
      ? parsed.data.title.trim()
      : extractHeading(parsed.content) ?? prettifyTitle(path.basename(relativePath, path.extname(relativePath)));

  const tags = Array.isArray(parsed.data?.tags)
    ? parsed.data.tags.map((tag) => String(tag).trim()).filter(Boolean)
    : [];

  const fileStat = await stat(absolutePath);

  return {
    relativePath,
    absolutePath,
    title,
    tags,
    summary: createExcerpt(parsed.content),
    directory: toPosix(path.dirname(relativePath)),
    topLevel: toPosix(relativePath).split("/")[0] || "root",
    updatedAt: fileStat.mtime.toISOString(),
  };
}

export async function readNoteDocument(config, relativePath) {
  const absolutePath = path.join(config.sourceRoot, relativePath);
  const raw = await readUtf8TextFile(absolutePath, `note ${relativePath}`);
  const parsed = matter(raw);
  return {
    absolutePath,
    raw,
    parsed,
  };
}

export async function collectPublishedPreview(config, notesState) {
  const publishedPaths = Object.entries(notesState)
    .filter(([, value]) => value?.publish === true)
    .map(([relativePath]) => relativePath);

  const assetMap = new Map();

  for (const relativePath of publishedPaths) {
    const { absolutePath, parsed } = await readNoteDocument(config, relativePath);
    const assets = collectNoteAssetTargets(parsed.content, parsed.data?.cover);

    for (const target of assets) {
      const resolved = resolveAssetForPreview(config, absolutePath, target);
      if (!resolved || assetMap.has(resolved.key)) continue;
      assetMap.set(resolved.key, resolved);
    }
  }

  const existingAssets = [];
  const missingAssets = [];

  for (const asset of assetMap.values()) {
    if (await fileExists(asset.absolutePath)) {
      existingAssets.push(asset);
    } else {
      missingAssets.push(asset);
    }
  }

  return {
    publishedCount: publishedPaths.length,
    assetCount: existingAssets.length,
    missingAssetCount: missingAssets.length,
    publishedPaths,
    existingAssets: existingAssets.map((asset) => asset.publicPath),
    missingAssets: missingAssets.map((asset) => asset.publicPath),
  };
}

export async function getPublishedNotesWithChanges(config, publishState, notePaths) {
  const changedNotes = [];

  for (const relativePath of notePaths) {
    const entry = normalizeStateEntry(publishState.notes?.[relativePath]);
    if (!entry?.publish) continue;

    const fingerprint = await computeNoteSyncFingerprint(config, relativePath);
    if (entry.syncedHash !== fingerprint) {
      changedNotes.push({
        relativePath,
        title: (await readNoteMeta(config, relativePath)).title,
        fingerprint,
        syncedHash: entry.syncedHash ?? null,
      });
    }
  }

  return changedNotes;
}

export async function updatePublishedSyncState(config, publishState, notePaths, timestamp = new Date().toISOString()) {
  const notes = { ...(publishState.notes ?? {}) };

  for (const relativePath of notePaths) {
    const entry = normalizeStateEntry(notes[relativePath]) ?? {
      publish: false,
      syncedHash: null,
      syncedAt: null,
    };

    if (!entry.publish) {
      notes[relativePath] = {
        ...entry,
        syncedHash: null,
        syncedAt: null,
      };
      continue;
    }

    notes[relativePath] = {
      ...entry,
      syncedHash: await computeNoteSyncFingerprint(config, relativePath),
      syncedAt: timestamp,
    };
  }

  const nextState = { notes };
  await savePublishState(nextState);
  return nextState;
}

export async function computeNoteSyncFingerprint(config, relativePath) {
  const { absolutePath, raw, parsed } = await readNoteDocument(config, relativePath);
  const noteStat = await stat(absolutePath);
  const hash = createHash("sha1");

  hash.update(relativePath);
  hash.update("\n");
  hash.update(raw);
  hash.update("\n");
  hash.update(String(noteStat.size));
  hash.update("\n");
  hash.update(String(noteStat.mtimeMs));

  const assetTargets = collectNoteAssetTargets(parsed.content, parsed.data?.cover);
  for (const target of assetTargets) {
    const resolved = resolveAssetForPreview(config, absolutePath, target);
    if (!resolved) continue;

    hash.update("\nasset:");
    hash.update(resolved.publicPath);

    try {
      const assetStat = await stat(resolved.absolutePath);
      hash.update(`:${assetStat.size}:${assetStat.mtimeMs}`);
    } catch {
      hash.update(":missing");
    }
  }

  return hash.digest("hex");
}

export function getStatePath() {
  return statePath;
}

export function getLiveStatePath() {
  return liveStatePath;
}

export function toPosix(value) {
  return value.split(path.sep).join("/");
}

export function normalizeRouteSlug(relativePath) {
  return toPosix(relativePath)
    .replace(/\.[^.]+$/, "")
    .split("/")
    .map((segment) => segment.trim().replace(/\s+/g, "-"))
    .filter(Boolean)
    .join("/");
}

export function getSharedGalleryRoots(config) {
  return config.sharedGalleryDirs.map((name) => path.join(config.sourceRoot, name));
}

export function isSharedGalleryPath(target, config) {
  const normalized = target.replace(/^\/+/, "").replace(/\\/g, "/");
  const rootName = normalized.split("/")[0];
  return config.sharedGalleryDirs.includes(rootName);
}

export function resolveSharedGallerySource(target, config) {
  const normalized = target.replace(/^\/+/, "").replace(/\\/g, "/");
  const rootName = normalized.split("/")[0];
  const relativePath = normalized.slice(rootName.length + 1);
  return path.join(config.sourceRoot, rootName, relativePath);
}

function ensureStringArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function normalizeAbsolutePath(value) {
  return path.resolve(String(value));
}

function isLegacyPublished(relativePath, roots) {
  const normalized = toPosix(relativePath);
  return roots.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

function isTemplateMarkdown(relativePath) {
  const base = path.basename(relativePath);
  return /^00-.*(?:模板|template)\.(md|mdx)$/i.test(base) || /template/i.test(base);
}

function extractHeading(content) {
  return content.match(/^\s*#\s+(.+?)\s*$/m)?.[1]?.trim() ?? null;
}

function prettifyTitle(value) {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function createExcerpt(content) {
  return content
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/!\[\[[^\]]+\]\]/g, " ")
    .replace(/<img[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}

function extractMarkdownAssets(content) {
  const assets = [];
  for (const match of content.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
    assets.push(match[1]);
  }
  for (const match of content.matchAll(/!\[\[([^\]]+)\]\]/g)) {
    assets.push(match[1]);
  }
  for (const match of content.matchAll(/<img\s+[^>]*src=(["'])(.*?)\1[^>]*>/g)) {
    assets.push(match[2]);
  }
  return assets;
}

function collectNoteAssetTargets(content, cover) {
  const assets = extractMarkdownAssets(content);
  if (typeof cover === "string" && cover.trim()) {
    assets.push(cover.trim());
  }

  return assets
    .map((target) => target.trim().replace(/^<|>$/g, ""))
    .filter((target) => target && !isExternalUrl(target));
}

function resolveAssetForPreview(config, noteAbsolutePath, target) {
  const cleanTarget = target.match(/^([^?#]+)(.*)$/)?.[1] ?? target;
  if (/\.(md|mdx)$/i.test(cleanTarget)) {
    return null;
  }

  if (isSharedGalleryPath(cleanTarget, config)) {
    return {
      key: cleanTarget,
      publicPath: cleanTarget.replace(/\\/g, "/"),
      absolutePath: resolveSharedGallerySource(cleanTarget, config),
    };
  }

  const noteDir = path.dirname(noteAbsolutePath);
  const absolutePath = path.resolve(noteDir, cleanTarget);
  if (!absolutePath.startsWith(config.sourceRoot)) {
    return null;
  }

  const publicPath = toPosix(path.relative(config.sourceRoot, absolutePath));
  return {
    key: publicPath,
    publicPath,
    absolutePath,
  };
}

function normalizeStateEntry(entry) {
  if (typeof entry === "boolean") {
    return {
      publish: entry,
      syncedHash: null,
      syncedAt: null,
    };
  }

  if (!entry || typeof entry !== "object") {
    return null;
  }

  return {
    publish: entry.publish === true,
    syncedHash: typeof entry.syncedHash === "string" && entry.syncedHash.trim() ? entry.syncedHash.trim() : null,
    syncedAt: typeof entry.syncedAt === "string" && entry.syncedAt.trim() ? entry.syncedAt.trim() : null,
  };
}

function isSameStateEntry(left, right) {
  return left?.publish === right?.publish &&
    left?.syncedHash === right?.syncedHash &&
    left?.syncedAt === right?.syncedAt;
}

function isExternalUrl(value) {
  return /^(?:[a-z]+:)?\/\//i.test(value) || value.startsWith("data:") || value.startsWith("#");
}

function isEnoentError(error) {
  return (error && typeof error === "object" && "code" in error && error.code === "ENOENT") ||
    (error instanceof Error && /ENOENT/i.test(error.message));
}

async function fileExists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
