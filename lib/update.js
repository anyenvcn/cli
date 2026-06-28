import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DEFAULT_API_BASE, VERSION, normalizeApiBase } from "./config.js";

export const DEFAULT_CLI_BASE_URL = "https://api.anyenv.cn/api/v1/cli";

function deriveCliBaseFromApi(apiBase) {
  const normalized = normalizeApiBase(apiBase || DEFAULT_API_BASE);
  return normalized.replace(/\/api\/v1$/, "/api/v1/cli");
}

export function resolveCliBaseUrl(options = {}) {
  const explicit = options.baseUrl || options["base-url"] || process.env.ANYENV_CLI_BASE_URL;
  if (explicit) return String(explicit).trim().replace(/\/+$/, "");
  const apiBase = options.api || process.env.ANYENV_API_BASE || "";
  if (apiBase) return deriveCliBaseFromApi(apiBase);
  return DEFAULT_CLI_BASE_URL;
}

export function platformAsset() {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === "darwin" && arch === "arm64") return "anyenv-darwin-arm64.tar.gz";
  if (platform === "darwin" && arch === "x64") return "anyenv-darwin-x64.tar.gz";
  if (platform === "linux" && arch === "arm64") return "anyenv-linux-arm64.tar.gz";
  if (platform === "linux" && arch === "x64") return "anyenv-linux-x64.tar.gz";
  if (platform === "win32" && arch === "x64") return "anyenv-windows-x64.zip";
  throw new Error(`Unsupported platform for AnyEnv CLI update: ${platform}/${arch}`);
}

export function isTemporaryPath(target) {
  const value = String(target || "");
  if (!value) return false;
  const tmpDir = process.env.TMPDIR || "";
  if (tmpDir && value.startsWith(tmpDir)) return true;
  const normalized = value.replace(/\\/g, "/");
  return /^(\/private)?\/(tmp|var\/tmp)\//.test(normalized)
    || /^(\/private)?\/var\/folders\/[^/]+\/[^/]+\/T\//.test(normalized);
}

function canWriteDir(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function posixShell() {
  for (const candidate of ["/bin/sh", "/usr/bin/sh"]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return "sh";
}

function commandPath(command) {
  const result = process.platform === "win32"
    ? spawnSync("where", [command], { stdio: "pipe", encoding: "utf8", shell: true })
    : spawnSync(posixShell(), ["-c", `command -v ${command}`], { stdio: "pipe", encoding: "utf8" });
  if (result.status !== 0) return "";
  return String(result.stdout || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
}

function canonicalPath(target) {
  if (!target) return "";
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

function commandVersion(command) {
  const result = spawnSync(command, ["--version"], {
    stdio: "pipe",
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) return "";
  return String(result.stdout || result.stderr || "").trim().split(/\r?\n/)[0] || "";
}

function isMachOBinary(file) {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(4);
      if (fs.readSync(fd, buffer, 0, 4, 0) !== 4) return false;
      return new Set([
        "feedface",
        "cefaedfe",
        "feedfacf",
        "cffaedfe",
        "cafebabe",
        "bebafeca",
        "cafebabf",
        "bfbafeca",
      ]).has(buffer.toString("hex"));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function signMacBinary(file) {
  if (process.platform !== "darwin" || !isMachOBinary(file)) return false;
  const result = spawnSync("codesign", ["--force", "--sign", "-", file], {
    stdio: "pipe",
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`macOS codesign failed for installed AnyEnv CLI: ${(result.stderr || result.stdout || result.error?.message || "").trim()}`);
  }
  const verify = spawnSync("codesign", ["--verify", file], {
    stdio: "pipe",
    encoding: "utf8",
    shell: false,
  });
  if (verify.status !== 0) {
    throw new Error(`macOS codesign verification failed for installed AnyEnv CLI: ${(verify.stderr || verify.stdout || verify.error?.message || "").trim()}`);
  }
  return true;
}

function smokeBinary(file, label = "AnyEnv CLI") {
  const result = spawnSync(file, ["--version"], {
    stdio: "pipe",
    encoding: "utf8",
    shell: process.platform === "win32",
    timeout: 10000,
  });
  if (result.status !== 0) {
    const reason = result.signal || result.status || result.error?.message || "unknown";
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(`${label} failed smoke test (${reason})${detail ? `: ${detail}` : ""}`);
  }
  const version = String(result.stdout || result.stderr || "").trim().split(/\r?\n/)[0] || "";
  if (!/\d+\.\d+/.test(version)) {
    throw new Error(`${label} returned an unexpected version: ${version || "(empty)"}`);
  }
  return version;
}

function prepareInstallCandidate(file, label = "AnyEnv CLI") {
  const signed = signMacBinary(file);
  const smokeVersion = smokeBinary(file, label);
  return { signed, smokeVersion };
}

function defaultInstallDir() {
  if (process.pkg && process.execPath && !isTemporaryPath(process.execPath) && canWriteDir(path.dirname(process.execPath))) {
    return path.dirname(process.execPath);
  }
  const active = commandPath(binaryName());
  if (active && !isTemporaryPath(active) && canWriteDir(path.dirname(active))) {
    return path.dirname(active);
  }
  if (process.platform === "win32") return path.join(os.homedir(), ".anyenv", "bin");
  return path.join(os.homedir(), ".local", "bin");
}

export function resolveInstallDir(options = {}) {
  return path.resolve(options["install-dir"] || process.env.ANYENV_INSTALL_DIR || defaultInstallDir());
}

function binaryName() {
  return process.platform === "win32" ? "anyenv.exe" : "anyenv";
}

export function activationScript(installDir = resolveInstallDir()) {
  const normalized = path.resolve(installDir);
  if (process.platform === "win32") {
    return `$env:Path = "${normalized};$env:Path"`;
  }
  const quoted = `'${normalized.replace(/'/g, "'\\''")}'`;
  return `export PATH=${quoted}:$PATH\nhash -r 2>/dev/null || true`;
}

export function activationEvalCommand(installDir = resolveInstallDir()) {
  const target = path.join(path.resolve(installDir), binaryName());
  if (process.platform === "win32") {
    return `& "${target}" env activate`;
  }
  const quotedTarget = `'${target.replace(/'/g, "'\\''")}'`;
  return `eval "$(${quotedTarget} env activate)"`;
}

export function updatePathDiagnostics(installDir = resolveInstallDir()) {
  const activePath = commandPath(binaryName());
  const targetPath = path.join(path.resolve(installDir), binaryName());
  const activeVersion = activePath ? commandVersion(activePath) : "";
  const targetVersion = fs.existsSync(targetPath) ? commandVersion(targetPath) : "";
  const activeMatchesInstall = Boolean(activePath) && canonicalPath(activePath) === canonicalPath(targetPath);
  return {
    activePath,
    activeVersion,
    activeMatchesInstall,
    targetVersion,
    shellActivation: activationScript(installDir),
    activationCommand: activationEvalCommand(installDir),
  };
}

export function discoverAnyenvInstallations(options = {}) {
  const pathEnv = options.pathEnv ?? process.env.PATH ?? "";
  const activePath = commandPath(binaryName());
  const activeCanonical = canonicalPath(activePath);
  const seen = new Set();
  const installs = [];

  for (const dir of String(pathEnv).split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, binaryName());
    if (!fs.existsSync(candidate)) continue;
    let stat;
    try {
      stat = fs.statSync(candidate);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const canonical = canonicalPath(candidate);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    installs.push({
      path: candidate,
      canonicalPath: canonical,
      version: commandVersion(candidate),
      active: Boolean(activeCanonical) && canonical === activeCanonical,
      temporary: isTemporaryPath(candidate),
    });
  }

  if (activePath && !seen.has(activeCanonical)) {
    installs.unshift({
      path: activePath,
      canonicalPath: activeCanonical,
      version: commandVersion(activePath),
      active: true,
      temporary: isTemporaryPath(activePath),
    });
  }

  return installs;
}

function safeCleanupRoots(tmpRoot) {
  const root = path.resolve(tmpRoot || os.tmpdir());
  return [
    { root, prefix: "anyenv-update-" },
  ];
}

export function cleanupCliArtifacts(options = {}) {
  const dryRun = Boolean(options["dry-run"] || options.dryRun);
  const tmpRoot = options["tmp-dir"] || process.env.ANYENV_CLEANUP_TMPDIR || os.tmpdir();
  const cleaned = [];

  for (const rule of safeCleanupRoots(tmpRoot)) {
    if (!fs.existsSync(rule.root)) continue;
    for (const entry of fs.readdirSync(rule.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(rule.prefix)) continue;
      const full = path.join(rule.root, entry.name);
      const record = { path: full, removed: false, error: "" };
      if (!dryRun) {
        try {
          fs.rmSync(full, { recursive: true, force: true });
          record.removed = true;
        } catch (err) {
          record.error = err?.message || String(err);
        }
      }
      cleaned.push(record);
    }
  }

  return {
    dryRun,
    tmpRoot: path.resolve(tmpRoot),
    cleaned,
    installations: discoverAnyenvInstallations(options),
  };
}

function sha256(file) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

function expectedChecksum(text, asset) {
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length >= 2 && parts[1] === asset) return parts[0].toLowerCase();
  }
  return "";
}

export function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

async function download(url, file, options = {}) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${url} -> ${res.status}`);
  const total = Number(res.headers.get("content-length") || 0);
  let loaded = 0;
  const chunks = [];
  options.onProgress?.({ label: options.label || path.basename(file), loaded, total, done: false, started: true });
  if (res.body && typeof res.body[Symbol.asyncIterator] === "function") {
    for await (const chunk of res.body) {
      const buffer = Buffer.from(chunk);
      chunks.push(buffer);
      loaded += buffer.length;
      options.onProgress?.({ label: options.label || path.basename(file), loaded, total, done: false });
    }
  } else {
    const bytes = Buffer.from(await res.arrayBuffer());
    chunks.push(bytes);
    loaded = bytes.length;
    options.onProgress?.({ label: options.label || path.basename(file), loaded, total, done: false });
  }
  const bytes = Buffer.concat(chunks);
  fs.writeFileSync(file, bytes);
  options.onProgress?.({ label: options.label || path.basename(file), loaded: bytes.length, total: total || bytes.length, done: true });
}

async function downloadText(url, options = {}) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${url} -> ${res.status}`);
  const text = await res.text();
  options.onProgress?.({
    label: options.label || path.basename(new URL(url).pathname),
    loaded: Buffer.byteLength(text),
    total: Buffer.byteLength(text),
    done: true,
    text: true,
  });
  return text;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "pipe",
    encoding: "utf8",
    shell: process.platform === "win32",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
}

function findBinary(root) {
  const wanted = binaryName();
  const stack = [root];
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

function extractArchive(archive, tmpDir, asset) {
  if (asset.endsWith(".zip")) {
    run("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Expand-Archive -LiteralPath ${JSON.stringify(archive)} -DestinationPath ${JSON.stringify(tmpDir)} -Force`,
    ]);
    return;
  }
  run("tar", ["-xzf", archive, "-C", tmpDir]);
}

function uniqueInstallSibling(targetPath, suffix) {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const random = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return path.join(dir, `.${base}.${process.pid}.${random}.${suffix}`);
}

function backupInstallTarget(targetPath) {
  if (!fs.existsSync(targetPath)) return { existed: false, path: "", mode: 0o755 };
  const stat = fs.statSync(targetPath);
  if (!stat.isFile()) throw new Error(`Install target is not a file: ${targetPath}`);
  const backupPath = uniqueInstallSibling(targetPath, "previous");
  fs.renameSync(targetPath, backupPath);
  const mode = stat.mode & 0o777;
  if (process.platform !== "win32") fs.chmodSync(backupPath, mode || 0o755);
  return { existed: true, path: backupPath, mode: mode || 0o755 };
}

function restoreInstallTarget(targetPath, backup) {
  try {
    fs.rmSync(targetPath, { force: true });
  } catch {}
  if (backup?.existed && backup.path && fs.existsSync(backup.path)) {
    fs.renameSync(backup.path, targetPath);
    if (process.platform !== "win32") fs.chmodSync(targetPath, backup.mode || 0o755);
    return true;
  }
  return false;
}

function cleanupInstallBackup(backup) {
  if (backup?.path) {
    try {
      fs.rmSync(backup.path, { force: true });
    } catch {}
  }
}

function isCurrentExecutableTarget(targetPath) {
  if (!process.pkg || !process.execPath) return false;
  return canonicalPath(process.execPath) === canonicalPath(targetPath);
}

export async function updateCli(options = {}) {
  const baseUrl = resolveCliBaseUrl(options);
  const version = String(options.version || process.env.ANYENV_VERSION || "latest");
  const asset = platformAsset();
  const installDir = resolveInstallDir(options);
  const targetPath = path.join(installDir, binaryName());
  const result = {
    currentVersion: VERSION,
    version,
    baseUrl,
    asset,
    installDir,
    targetPath,
    path: updatePathDiagnostics(installDir),
  };

  if (options["dry-run"]) return { ...result, dryRun: true };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-update-"));
  try {
    const archive = path.join(tmpDir, asset);
    const checksumsUrl = `${baseUrl}/releases/${version}/download/SHA256SUMS`;
    const assetUrl = `${baseUrl}/releases/${version}/download/${asset}`;
    const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
    const checksums = await downloadText(checksumsUrl, { label: "SHA256SUMS", onProgress });
    const expected = expectedChecksum(checksums, asset);
    if (!expected) throw new Error(`Checksum for ${asset} not found in SHA256SUMS`);
    await download(assetUrl, archive, { label: asset, onProgress });
    const actual = sha256(archive);
    if (actual.toLowerCase() !== expected) {
      throw new Error(`Checksum mismatch for ${asset}: expected ${expected}, got ${actual}`);
    }
    extractArchive(archive, tmpDir, asset);
    const binary = findBinary(tmpDir);
    if (!binary) throw new Error(`${binaryName()} not found in downloaded archive`);
    fs.mkdirSync(installDir, { recursive: true });
    const candidatePath = path.join(tmpDir, `candidate-${binaryName()}`);
    fs.copyFileSync(binary, candidatePath);
    if (process.platform !== "win32") fs.chmodSync(candidatePath, 0o755);
    prepareInstallCandidate(candidatePath, "Downloaded AnyEnv CLI");

    const stagedPath = uniqueInstallSibling(targetPath, "candidate");
    fs.copyFileSync(candidatePath, stagedPath);
    if (process.platform !== "win32") fs.chmodSync(stagedPath, 0o755);
    const staged = prepareInstallCandidate(stagedPath, "Staged AnyEnv CLI");
    const replacingCurrentExecutable = isCurrentExecutableTarget(targetPath);

    const backup = backupInstallTarget(targetPath);
    try {
      fs.renameSync(stagedPath, targetPath);
      const installed = replacingCurrentExecutable
        ? staged
        : prepareInstallCandidate(targetPath, "Installed AnyEnv CLI");
      cleanupInstallBackup(backup);
      const pathDiagnostics = updatePathDiagnostics(installDir);
      if (replacingCurrentExecutable) {
        if (!pathDiagnostics.targetVersion) pathDiagnostics.targetVersion = installed.smokeVersion;
        if (pathDiagnostics.activeMatchesInstall && !pathDiagnostics.activeVersion) {
          pathDiagnostics.activeVersion = installed.smokeVersion;
        }
      }
      return {
        ...result,
        dryRun: false,
        checksum: actual,
        binaryChecksum: sha256(targetPath),
        signed: installed.signed,
        smokeVersion: installed.smokeVersion,
        skippedInstalledSmoke: replacingCurrentExecutable,
        path: pathDiagnostics,
      };
    } catch (err) {
      try {
        fs.rmSync(stagedPath, { force: true });
      } catch {}
      const restored = restoreInstallTarget(targetPath, backup);
      const message = err?.message || String(err);
      throw new Error(`${message}${restored ? "; restored the previous AnyEnv CLI binary" : "; removed the failed AnyEnv CLI install"}`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
