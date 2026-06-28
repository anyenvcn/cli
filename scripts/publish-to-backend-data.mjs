import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = path.resolve(root, "..");
const pkgJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const artifactDir = path.join(root, "dist", "artifacts");

function defaultDownloadRoot() {
  const monorepoBackend = path.join(repoRoot, "backend");
  if (fs.existsSync(monorepoBackend)) {
    return path.join(monorepoBackend, "data", "downloads", "cli");
  }
  return path.join(root, "dist", "downloads", "cli");
}

const targetRoot = path.resolve(
  process.env.ANYENV_CLI_DOWNLOAD_DIR || defaultDownloadRoot(),
);

function copyArtifacts(targetDir) {
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });
  for (const name of fs.readdirSync(artifactDir)) {
    const source = path.join(artifactDir, name);
    if (!fs.statSync(source).isFile()) continue;
    fs.copyFileSync(source, path.join(targetDir, name));
  }
}

if (!fs.existsSync(artifactDir)) {
  throw new Error("Missing dist/artifacts. Run npm run package first.");
}

const versionDir = path.join(targetRoot, pkgJson.version);
const latestDir = path.join(targetRoot, "latest");
copyArtifacts(versionDir);
copyArtifacts(latestDir);

console.log(`published AnyEnv CLI ${pkgJson.version} artifacts to:`);
console.log(`  ${versionDir}`);
console.log(`  ${latestDir}`);
