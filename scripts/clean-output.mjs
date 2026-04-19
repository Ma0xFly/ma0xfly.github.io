import { readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(rootDir, "dist");

for (const target of [
  path.join(rootDir, ".astro"),
  path.join(rootDir, "node_modules", ".astro"),
]) {
  await rm(target, { recursive: true, force: true });
}

try {
  const entries = await readdir(distDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git") {
      continue;
    }
    await rm(path.join(distDir, entry.name), { recursive: true, force: true });
  }
} catch {}

try {
  await writeFile(path.join(distDir, ".nojekyll"), "", "ascii");
} catch {}
