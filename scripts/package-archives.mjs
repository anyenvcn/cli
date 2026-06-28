import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const pkgJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const binDir = path.join(root, "dist", "bin");
const stagingDir = path.join(root, "dist", "package");
const artifactDir = path.join(root, "dist", "artifacts");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || root,
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options,
    env: {
      ...process.env,
      // Avoid macOS extended attributes such as LIBARCHIVE.xattr.* leaking into
      // tarballs and producing warnings during Linux installs.
      COPYFILE_DISABLE: "1",
      ...(options.env || {}),
    },
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with code ${result.status}`);
  }
}

function sha256(file) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

function binaryNameForAsset(asset) {
  return asset.endsWith(".zip") ? "anyenv.exe" : "anyenv";
}

function platformAsset() {
  if (process.platform === "darwin" && process.arch === "arm64") return "anyenv-darwin-arm64.tar.gz";
  if (process.platform === "darwin" && process.arch === "x64") return "anyenv-darwin-x64.tar.gz";
  if (process.platform === "linux" && process.arch === "arm64") return "anyenv-linux-arm64.tar.gz";
  if (process.platform === "linux" && process.arch === "x64") return "anyenv-linux-x64.tar.gz";
  if (process.platform === "win32" && process.arch === "x64") return "anyenv-windows-x64.zip";
  return "";
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

function smokeArchive(archive, asset) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-archive-smoke-"));
  try {
    extractArchive(archive, tmpDir, asset);
    const binary = findBinary(tmpDir, asset);
    if (!binary) throw new Error(`${binaryNameForAsset(asset)} not found in ${path.basename(archive)}`);
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
      throw new Error(`${path.basename(archive)} failed archive smoke test (${reason})${detail ? `: ${detail}` : ""}`);
    }
    const version = String(result.stdout || result.stderr || "").trim().split(/\r?\n/)[0] || "";
    if (version !== pkgJson.version) {
      throw new Error(`${path.basename(archive)} returned ${version || "(empty)"} instead of ${pkgJson.version}`);
    }
    console.log(`smoked ${path.basename(archive)} (${version})`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function writeReadme(dir, binaryName) {
  fs.writeFileSync(
    path.join(dir, "README.txt"),
    [
      `AnyEnv CLI ${pkgJson.version}`,
      "",
      "Quick start:",
      `  ./${binaryName} login`,
      `  ./${binaryName} token set --token <fullToken>`,
      `  ./${binaryName} local status`,
      `  ./${binaryName} mcp`,
      "",
      "Tokens are stored only in your local config unless you pass them via environment variables.",
      "Default config path: ~/.anyenv/config.json",
      "",
    ].join("\n"),
  );
}

function stripMacExtendedAttributes(dir) {
  if (process.platform !== "darwin") return;
  const result = spawnSync("xattr", ["-cr", dir], {
    cwd: root,
    stdio: "ignore",
    shell: false,
  });
  if (result.status !== 0) {
    console.warn(`warning: failed to strip macOS extended attributes from ${dir}`);
  }
}

fs.rmSync(stagingDir, { recursive: true, force: true });
fs.rmSync(artifactDir, { recursive: true, force: true });
fs.mkdirSync(stagingDir, { recursive: true });
fs.mkdirSync(artifactDir, { recursive: true });

const binaries = fs.readdirSync(binDir)
  .filter((name) => name.startsWith("anyenv-") && !name.endsWith(".map"))
  .sort();

for (const binary of binaries) {
  const source = path.join(binDir, binary);
  if (!fs.statSync(source).isFile()) continue;
  const isWindows = binary.endsWith(".exe");
  const base = binary.replace(/\.exe$/, "");
  const packageName = `anyenv-${pkgJson.version}-${base.replace(/^anyenv-/, "")}`;
  const packageDir = path.join(stagingDir, packageName);
  fs.mkdirSync(packageDir, { recursive: true });
  const packagedBinary = isWindows ? "anyenv.exe" : "anyenv";
  fs.copyFileSync(source, path.join(packageDir, packagedBinary));
  if (!isWindows) fs.chmodSync(path.join(packageDir, packagedBinary), 0o755);
  writeReadme(packageDir, packagedBinary);
  stripMacExtendedAttributes(packageDir);

  if (isWindows) {
    const archive = path.join(artifactDir, `${base}.zip`);
    run("zip", ["-qr", archive, packageName], { cwd: stagingDir });
    if (path.basename(archive) === platformAsset()) smokeArchive(archive, path.basename(archive));
  } else {
    const archive = path.join(artifactDir, `${base}.tar.gz`);
    const tarArgs = process.platform === "darwin"
      ? ["--no-xattrs", "-czf", archive, packageName]
      : ["-czf", archive, packageName];
    run("tar", tarArgs, { cwd: stagingDir });
    if (path.basename(archive) === platformAsset()) smokeArchive(archive, path.basename(archive));
  }
}

const artifacts = fs.readdirSync(artifactDir).sort();
const checksums = artifacts
  .map((name) => `${sha256(path.join(artifactDir, name))}  ${name}`)
  .join("\n");
fs.writeFileSync(path.join(artifactDir, "SHA256SUMS"), `${checksums}\n`);
console.log(`created ${artifacts.length} archives in ${path.relative(root, artifactDir)}`);
