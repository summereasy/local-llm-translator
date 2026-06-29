import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const dist = join(root, "dist");

async function copy(from: string, to: string) {
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const result = await Bun.build({
  entrypoints: [
    join(root, "src/background.ts"),
    join(root, "src/content.ts"),
    join(root, "src/popup.ts"),
    join(root, "src/options.ts")
  ],
  outdir: dist,
  target: "browser",
  format: "esm",
  minify: false,
  sourcemap: "external"
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

await Promise.all([
  copy(join(root, "public/manifest.json"), join(dist, "manifest.json")),
  copy(join(root, "public/rules/request_modifier_rule.json"), join(dist, "rules/request_modifier_rule.json")),
  copy(join(root, "public/icon/16.png"), join(dist, "icon/16.png")),
  copy(join(root, "public/icon/32.png"), join(dist, "icon/32.png")),
  copy(join(root, "public/icon/48.png"), join(dist, "icon/48.png")),
  copy(join(root, "public/icon/64.png"), join(dist, "icon/64.png")),
  copy(join(root, "public/icon/128.png"), join(dist, "icon/128.png")),
  copy(join(root, "public/icon/512.png"), join(dist, "icon/512.png")),
  copy(join(root, "src/popup.html"), join(dist, "popup.html")),
  copy(join(root, "src/options.html"), join(dist, "options.html")),
  copy(join(root, "src/styles/content.css"), join(dist, "content.css")),
  copy(join(root, "src/styles/ui.css"), join(dist, "ui.css"))
]);

console.log(`Built ${dist}`);
