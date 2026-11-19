import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import pageProbe from "../../dist/vite/plugin.js";

const token = process.env.PAGE_PROBE_TOKEN ??
  readFileSync(new URL("../../.page-probe-token", import.meta.url), "utf8").trim();

export default defineConfig({
  plugins: [pageProbe({ token })],
});
