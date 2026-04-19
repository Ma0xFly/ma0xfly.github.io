import { readFileSync } from "node:fs";
import { defineConfig } from "astro/config";

const siteConfig = JSON.parse(
  readFileSync(new URL("./src/config/site.json", import.meta.url), "utf8"),
);

export default defineConfig({
  site: siteConfig.siteUrl,
  markdown: {
    shikiConfig: {
      langAlias: {
        Solidity: "solidity",
      },
    },
  },
});
