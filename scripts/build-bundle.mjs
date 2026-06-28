import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const outfile = path.join(root, "dist", "anyenv.cjs");

fs.mkdirSync(path.dirname(outfile), { recursive: true });

await build({
  entryPoints: [path.join(root, "bin", "anyenv.js")],
  outfile,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  logLevel: "info",
});

fs.chmodSync(outfile, 0o755);
console.log(`bundled ${path.relative(root, outfile)}`);
