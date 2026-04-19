import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeNoteSyncFingerprint,
  loadLiveState,
  loadPublishingConfig,
  readJsonUtf8File,
  saveLiveState,
  scanSourceNotes,
} from "./publishing-utils.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = await loadPublishingConfig();
const notePaths = await scanSourceNotes(config);
const liveState = await loadLiveState(config, notePaths);
const manifestPath = path.join(root, "src", "generated", "published-manifest.json");
const manifest = await readJsonUtf8File(manifestPath, "published manifest");
const publishedSet = new Set(
  (Array.isArray(manifest.publishedPosts) ? manifest.publishedPosts : [])
    .map((item) => String(item?.sourcePath || "").replace(/\\/g, "/"))
    .filter(Boolean),
);

const now = new Date().toISOString();
const notes = { ...(liveState.notes || {}) };

for (const relativePath of notePaths) {
  const existing = notes[relativePath];
  const prev = existing && typeof existing === "object"
    ? existing
    : { publish: false, syncedHash: null, syncedAt: null };

  if (publishedSet.has(relativePath)) {
    notes[relativePath] = {
      ...prev,
      publish: true,
      syncedHash: await computeNoteSyncFingerprint(config, relativePath),
      syncedAt: now,
    };
    continue;
  }

  notes[relativePath] = {
    ...prev,
    publish: false,
    syncedHash: null,
    syncedAt: null,
  };
}

await saveLiveState({ notes });
console.log(`live-state rebuilt from manifest: published=${publishedSet.size}, total=${notePaths.length}`);
