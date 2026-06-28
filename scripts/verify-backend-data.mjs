import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
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

const requiredAssets = [
  "SHA256SUMS",
  "anyenv-darwin-arm64.tar.gz",
  "anyenv-darwin-x64.tar.gz",
  "anyenv-linux-arm64.tar.gz",
  "anyenv-linux-x64.tar.gz",
  "anyenv-windows-x64.zip",
];

function sha256(file) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

function assertFile(file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`Missing file: ${file}`);
  }
}

function assertSameFile(left, right) {
  assertFile(left);
  assertFile(right);
  const leftHash = sha256(left);
  const rightHash = sha256(right);
  if (leftHash !== rightHash) {
    throw new Error(`Artifact mismatch:\n  ${left}\n  ${right}`);
  }
}

function verifyDirectory(name) {
  const targetDir = path.join(targetRoot, name);
  for (const asset of requiredAssets) {
    assertSameFile(path.join(artifactDir, asset), path.join(targetDir, asset));
  }
  smokeCurrentPlatformArchive(targetDir, name);
}

function platformAsset() {
  if (process.platform === "darwin" && process.arch === "arm64") return "anyenv-darwin-arm64.tar.gz";
  if (process.platform === "darwin" && process.arch === "x64") return "anyenv-darwin-x64.tar.gz";
  if (process.platform === "linux" && process.arch === "arm64") return "anyenv-linux-arm64.tar.gz";
  if (process.platform === "linux" && process.arch === "x64") return "anyenv-linux-x64.tar.gz";
  if (process.platform === "win32" && process.arch === "x64") return "anyenv-windows-x64.zip";
  return "";
}

function binaryNameForAsset(asset) {
  return asset.endsWith(".zip") ? "anyenv.exe" : "anyenv";
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "pipe",
    encoding: "utf8",
    shell: process.platform === "win32",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout || result.error?.message || "").trim()}`);
  }
}

function extractArchive(archive, destination, asset) {
  if (asset.endsWith(".zip")) {
    run("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Expand-Archive -LiteralPath ${JSON.stringify(archive)} -DestinationPath ${JSON.stringify(destination)} -Force`,
    ]);
    return;
  }
  run("tar", ["-xzf", archive, "-C", destination]);
}

function findBinary(rootDir, asset) {
  const wanted = binaryNameForAsset(asset);
  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name === wanted) return full;
    }
  }
  return "";
}

function smokeCurrentPlatformArchive(directory, label) {
  const asset = platformAsset();
  if (!asset) return;
  const archive = path.join(directory, asset);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-backend-smoke-"));
  try {
    extractArchive(archive, tmpDir, asset);
    const binary = findBinary(tmpDir, asset);
    if (!binary) throw new Error(`${binaryNameForAsset(asset)} not found in ${archive}`);
    if (process.platform !== "win32") fs.chmodSync(binary, 0o755);
    const result = spawnSync(binary, ["--version"], {
      cwd: tmpDir,
      stdio: "pipe",
      encoding: "utf8",
      shell: process.platform === "win32",
      timeout: 10000,
    });
    if (result.status !== 0) {
      const reason = result.signal || result.status || result.error?.message || "unknown";
      const detail = String(result.stderr || result.stdout || "").trim();
      throw new Error(`${label}/${asset} failed smoke test (${reason})${detail ? `: ${detail}` : ""}`);
    }
    const version = String(result.stdout || result.stderr || "").trim().split(/\r?\n/)[0] || "";
    if (version !== pkgJson.version) {
      throw new Error(`${label}/${asset} returned ${version || "(empty)"} instead of ${pkgJson.version}`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

for (const asset of requiredAssets) {
  assertFile(path.join(artifactDir, asset));
}

verifyDirectory(pkgJson.version);
verifyDirectory("latest");

console.log(`verified AnyEnv CLI ${pkgJson.version} backend download artifacts`);
