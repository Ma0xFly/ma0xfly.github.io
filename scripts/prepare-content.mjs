import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fg from "fast-glob";
import matter from "gray-matter";
import { z } from "zod";
import {
  findTextCorruptionIssues,
  isSharedGalleryPath,
  loadPublishingConfig,
  loadPublishState,
  normalizeRouteSlug,
  readUtf8TextFile,
  resolveSharedGallerySource,
  scanSourceNotes,
  toPosix,
} from "./publishing-utils.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generatedDataDir = path.join(rootDir, "src", "generated");
const publishedMediaDir = path.join(rootDir, "public", "__published_media");
const localNotesDir = path.join(rootDir, "notes", "local");
const projectGalleryDir = path.join(rootDir, "gallery");

await resetGeneratedDirs();

const config = await loadPublishingConfig();
const externalNotePaths = await scanSourceNotes(config);
const publishState = await loadPublishState(config, externalNotePaths);
const localNoteFiles = await fg("notes/local/**/*.{md,mdx}", {
  cwd: rootDir,
  onlyFiles: true,
});
const frontmatterSchema = z.object({
  title: z.string().trim().min(1).optional(),
  date: z.union([z.string(), z.number(), z.date()]).optional(),
  updated: z.union([z.string(), z.number(), z.date()]).optional(),
  tags: z.union([
    z.array(z.union([z.string(), z.number()])),
    z.string(),
  ]).optional(),
  summary: z.string().trim().min(1).optional(),
  cover: z.string().trim().min(1).optional(),
  publish: z.boolean().optional(),
}).passthrough();

const manifest = {
  generatedAt: new Date().toISOString(),
  totalNotes: localNoteFiles.length + externalNotePaths.length,
  publishedPosts: [],
  skipped: [],
  validation: {
    warningCount: 0,
    postsWithWarnings: 0,
  },
};

const generatedPosts = [];

for (const relativeNotePath of localNoteFiles) {
  const absoluteNotePath = path.join(rootDir, relativeNotePath);
  const result = await processNote({
    absoluteNotePath,
    sourcePath: toPosix(relativeNotePath),
    slug: normalizeRouteSlug(relativeNotePath.replace(/^notes\/local\//, "")),
    mode: "local",
  });
  if (result) generatedPosts.push(result);
}

for (const relativeNotePath of externalNotePaths) {
  const publishEntry = publishState.notes?.[relativeNotePath];
  if (publishEntry?.publish !== true) {
    manifest.skipped.push({
      sourcePath: toPosix(relativeNotePath),
      reason: "publish=false",
    });
    continue;
  }

  const absoluteNotePath = path.join(config.sourceRoot, relativeNotePath);
  const result = await processNote({
    absoluteNotePath,
    sourcePath: toPosix(relativeNotePath),
    slug: normalizeRouteSlug(relativeNotePath),
    mode: "external",
    publishedAt: publishEntry?.publishedAt,
  });
  if (result) generatedPosts.push(result);
}

generatedPosts.sort((left, right) => new Date(right.date).getTime() - new Date(left.date).getTime());

await mkdir(generatedDataDir, { recursive: true });
await writeFile(
  path.join(generatedDataDir, "posts.json"),
  `${JSON.stringify(generatedPosts, null, 2)}\n`,
  "utf8",
);
await writeFile(
  path.join(generatedDataDir, "published-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);

async function processNote({ absoluteNotePath, sourcePath, slug, mode, publishedAt }) {
  const raw = await readUtf8TextFile(absoluteNotePath, `note ${sourcePath}`);
  const parsed = matter(raw);
  const sourceData = parsed.data ?? {};
  const fileInfo = await stat(absoluteNotePath);

  if (mode === "local" && sourceData.publish !== true) {
    manifest.skipped.push({
      sourcePath,
      reason: "publish=false",
    });
    return null;
  }

  const copiedAssets = new Map();
  const warnings = [];
  const normalizedFrontmatter = validateFrontmatter(sourceData, {
    sourcePath,
    warnings,
  });

  const derivedTitle = getDerivedTitle(normalizedFrontmatter.title, parsed.content, slug);
  if (!normalizedFrontmatter.title) {
    warnings.push("Missing frontmatter.title; falling back to heading or filename.");
  }

  const resolvedDate = resolveDateValue(normalizedFrontmatter.date, fileInfo.mtime, "date", warnings);
  const resolvedUpdated = normalizedFrontmatter.updated
    ? resolveDateValue(normalizedFrontmatter.updated, fileInfo.mtime, "updated", warnings)
    : null;
  const sourceTags = normalizeTagsInput(normalizedFrontmatter.tags, warnings);
  const autoTags = mode === "external" ? getDirectoryTagsFromSourcePath(sourcePath) : [];
  const customTags = mode === "external"
    ? normalizeTags(publishState.notes?.[sourcePath]?.customTags)
    : [];
  const resolvedTags = mergeTags(sourceTags, autoTags, customTags);
  const resolvedSummary = resolveSummary(normalizedFrontmatter.summary, parsed.content, warnings);

  if (mode === "local" && typeof normalizedFrontmatter.publish !== "boolean") {
    warnings.push("Missing frontmatter.publish boolean for local note.");
  }

  pushCorruptionWarnings(warnings, "content", parsed.content);
  pushCorruptionWarnings(warnings, "title", derivedTitle);
  pushCorruptionWarnings(warnings, "summary", resolvedSummary);

  const body = normalizeCodeFenceLanguages(
    await rewriteMarkdownAssets(parsed.content, {
      mode,
      notePath: absoluteNotePath,
      copiedAssets,
      warnings,
    }),
  );
  const rewrittenCover = await rewriteSingleAsset(sourceData.cover, {
    mode,
    notePath: absoluteNotePath,
    copiedAssets,
    warnings,
  });

  const topLevel = sourcePath.split("/")[0] || "未分类";
  const directory = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : ".";

  const generated = {
    id: slug,
    slug,
    title: derivedTitle,
    date: resolvedDate,
    tags: resolvedTags,
    cover: rewrittenCover ?? null,
    summary: resolvedSummary,
    sourceNote: sourcePath,
    topLevel,
    directory,
    body,
    updated: resolvedUpdated,
    publishedAt: publishedAt ? normalizeDate(publishedAt) : null,
  };

  pushCorruptionWarnings(warnings, "generated body", body);

  manifest.publishedPosts.push({
    slug,
    sourcePath,
    assets: [...copiedAssets.keys()],
    warnings,
  });

  if (warnings.length > 0) {
    manifest.validation.warningCount += warnings.length;
    manifest.validation.postsWithWarnings += 1;
  }

  return generated;
}

async function resetGeneratedDirs() {
  await rm(generatedDataDir, { recursive: true, force: true });
  await rm(publishedMediaDir, { recursive: true, force: true });
  await rm(path.join(rootDir, "src", "content", "posts"), { recursive: true, force: true });
  await mkdir(generatedDataDir, { recursive: true });
  await mkdir(publishedMediaDir, { recursive: true });
}

async function rewriteMarkdownAssets(content, context) {
  let rewritten = content;

  rewritten = await replaceAsync(rewritten, /!\[([^\]]*)\]\(([^)]+)\)/g, async (match, alt, target) => {
    const nextTarget = await rewriteSingleAsset(target, context);
    return nextTarget ? `![${alt}](${nextTarget})` : match;
  });

  rewritten = await replaceAsync(rewritten, /!\[\[([^\]]+)\]\]/g, async (match, target) => {
    const nextTarget = await rewriteSingleAsset(target, context);
    return nextTarget ? `![](${nextTarget})` : match;
  });

  rewritten = await replaceAsync(
    rewritten,
    /<img\s+([^>]*?)src=(["'])(.*?)\2([^>]*?)>/g,
    async (match, before, quote, src, after) => {
      const nextTarget = await rewriteSingleAsset(src, context);
      return nextTarget ? `<img ${before}src=${quote}${nextTarget}${quote}${after}>` : match;
    },
  );

  return rewritten;
}

async function rewriteSingleAsset(rawValue, context) {
  if (typeof rawValue !== "string") {
    return rawValue;
  }

  const trimmed = rawValue.trim().replace(/^<|>$/g, "");
  if (!trimmed || isExternalAsset(trimmed)) {
    return rawValue;
  }

  const parts = splitTargetAndSuffix(trimmed);
  const resolved = context.mode === "external"
    ? await resolveExternalAsset(parts.target, context)
    : await resolveLocalAsset(parts.target, context);

  if (!resolved) {
    return rawValue;
  }

  return `${resolved}${parts.suffix}`;
}

async function resolveLocalAsset(target, context) {
  const noteDir = path.dirname(context.notePath);
  const absolutePath = toAbsoluteProjectAssetPath(target, noteDir);
  if (!absolutePath || !isInside(rootDir, absolutePath)) {
    context.warnings.push(`Skipped external path: ${target}`);
    return null;
  }

  let assetRelativePath;
  if (isInside(projectGalleryDir, absolutePath)) {
    assetRelativePath = path.join("project", "gallery", path.relative(projectGalleryDir, absolutePath));
  } else if (isInside(localNotesDir, absolutePath)) {
    assetRelativePath = path.join("project", "notes", path.relative(localNotesDir, absolutePath));
  } else {
    assetRelativePath = path.join("project", "files", path.relative(rootDir, absolutePath));
  }

  return copyPublishedAsset(absolutePath, assetRelativePath, context);
}

async function resolveExternalAsset(target, context) {
  const noteDir = path.dirname(context.notePath);
  let absolutePath;
  let assetRelativePath;

  if (isSharedGalleryPath(target, config)) {
    absolutePath = resolveSharedGallerySource(target, config);
    const normalized = target.replace(/^\/+/, "").replace(/\\/g, "/");
    assetRelativePath = path.join("external", normalized);
  } else {
    absolutePath = path.resolve(noteDir, target);
    if (!isInside(config.sourceRoot, absolutePath)) {
      context.warnings.push(`Skipped external path: ${target}`);
      return null;
    }
    assetRelativePath = path.join("external", path.relative(config.sourceRoot, absolutePath));
  }

  if (!(await fileExists(absolutePath))) {
    context.warnings.push(`Missing asset: ${target}`);
    return null;
  }

  return copyPublishedAsset(absolutePath, assetRelativePath, context);
}

async function copyPublishedAsset(absolutePath, assetRelativePath, context) {
  const normalizedAssetPath = toPosix(assetRelativePath);
  if (!context.copiedAssets.has(normalizedAssetPath)) {
    await mkdir(path.dirname(path.join(publishedMediaDir, normalizedAssetPath)), { recursive: true });
    await copyFile(absolutePath, path.join(publishedMediaDir, normalizedAssetPath));
    context.copiedAssets.set(normalizedAssetPath, true);
  }

  return `/__published_media/${normalizedAssetPath}`;
}

function toAbsoluteProjectAssetPath(target, noteDir) {
  const cleanTarget = splitTargetAndSuffix(target).target;
  if (cleanTarget.startsWith("/")) {
    return path.join(rootDir, cleanTarget.replace(/^\/+/, ""));
  }
  if (cleanTarget.startsWith("gallery/")) {
    return path.join(rootDir, cleanTarget);
  }
  return path.resolve(noteDir, cleanTarget);
}

function splitTargetAndSuffix(target) {
  const match = target.match(/^([^?#]+)(.*)$/);
  return match ? { target: match[1], suffix: match[2] ?? "" } : { target, suffix: "" };
}

function isExternalAsset(value) {
  return /^(?:[a-z]+:)?\/\//i.test(value) || value.startsWith("data:") || value.startsWith("#");
}

function normalizeTags(tags) {
  return Array.isArray(tags) ? tags.map((tag) => String(tag).trim()).filter(Boolean) : [];
}

function mergeTags(...groups) {
  const seen = new Set();
  const merged = [];
  for (const group of groups) {
    for (const tag of normalizeTags(group)) {
      const key = tag.toLocaleLowerCase("zh-CN");
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(tag);
    }
  }
  return merged;
}

function getDirectoryTagsFromSourcePath(sourcePath) {
  const normalized = toPosix(sourcePath);
  const directory = normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/")) : "";
  if (!directory || directory === ".") return [];
  return normalizeTags(directory.split("/").map((segment) => segment.trim()));
}

function normalizeTagsInput(tags, warnings) {
  if (Array.isArray(tags)) {
    return normalizeTags(tags);
  }

  if (typeof tags === "string" && tags.trim()) {
    return tags.split(/[，,]/).map((tag) => tag.trim()).filter(Boolean);
  }

  warnings.push("Missing frontmatter.tags; using empty tag list.");
  return [];
}

function normalizeDate(value) {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function resolveDateValue(value, fallbackDate, fieldName, warnings) {
  if (value === undefined || value === null || value === "") {
    warnings.push(`Missing frontmatter.${fieldName}; falling back to file modified time.`);
    return fallbackDate.toISOString();
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    warnings.push(`Invalid frontmatter.${fieldName}: ${String(value)}; falling back to file modified time.`);
    return fallbackDate.toISOString();
  }

  return date.toISOString();
}

function getDerivedTitle(title, content, slug) {
  // 优先级 1️⃣：如果 frontmatter 中有明确的 title，使用它
  if (typeof title === "string" && title.trim()) {
    return title.trim();
  }

  // 优先级 2️⃣：使用文件名作为标题（移除.md/.mdx扩展名）
  const fileName = slug.split("/").at(-1) ?? "Untitled";
  const fileNameTitle = fileName.replace(/\.(md|mdx)$/i, "");
  if (fileNameTitle) return fileNameTitle;

  // 优先级 3️⃣：提取 markdown 中的第一个 H1 标题（备选方案）
  const heading = content.match(/^\s*#\s+(.+?)\s*$/m)?.[1]?.trim();
  if (heading) return heading;

  return "Untitled";
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

function resolveSummary(summary, content, warnings) {
  if (typeof summary === "string" && summary.trim()) {
    return summary.trim();
  }

  const excerpt = createExcerpt(content);
  if (excerpt) {
    warnings.push("Missing frontmatter.summary; falling back to generated excerpt.");
    return excerpt;
  }

  warnings.push("Missing frontmatter.summary and generated excerpt is empty.");
  return "";
}

function validateFrontmatter(sourceData, { sourcePath, warnings }) {
  const result = frontmatterSchema.safeParse(sourceData);
  if (result.success) {
    return result.data;
  }

  warnings.push(`Frontmatter validation issues in ${sourcePath}: ${result.error.issues.map((issue) => issue.path.join(".") || "root").join(", ")}`);
  return sourceData;
}

function pushCorruptionWarnings(warnings, label, value) {
  for (const issue of findTextCorruptionIssues(value)) {
    warnings.push(`Possible encoding corruption in ${label}: ${issue}.`);
  }
}

function isInside(parent, child) {
  const relativePath = path.relative(parent, child);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function normalizeCodeFenceLanguages(content) {
  const aliasMap = new Map([
    ["Solidity", "solidity"],
    ["JavaScript", "javascript"],
    ["Bash", "bash"],
    ["Shell", "bash"],
    ["TypeScript", "typescript"],
  ]);

  return content.replace(/^```([A-Za-z][A-Za-z0-9_-]*)[ \t]*$/gm, (_fullMatch, lang) => {
    const normalized = aliasMap.get(lang) ?? lang;
    return `\`\`\`${normalized}`;
  });
}

async function replaceAsync(input, pattern, replacer) {
  const matches = [...input.matchAll(pattern)];
  if (matches.length === 0) return input;
  const replacements = await Promise.all(matches.map((match) => replacer(...match)));
  let output = "";
  let lastIndex = 0;
  matches.forEach((match, index) => {
    output += input.slice(lastIndex, match.index);
    output += replacements[index];
    lastIndex = match.index + match[0].length;
  });
  output += input.slice(lastIndex);
  return output;
}

async function fileExists(target) {
  try {
    await readFile(target);
    return true;
  } catch {
    return false;
  }
}
