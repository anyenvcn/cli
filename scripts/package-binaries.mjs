import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const pkgJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const bundlePath = path.join(root, "dist", "anyenv.cjs");
const outDir = path.join(root, "dist", "bin");

const DEFAULT_TARGETS = [
  "node20-macos-x64",
  "node20-macos-arm64",
  "node20-linux-x64",
  "node20-linux-arm64",
  "node20-win-x64",
];

const targets = (process.env.ANYENV_CLI_TARGETS || DEFAULT_TARGETS.join(","))
  .split(",")
  .map((target) => target.trim())
  .filter(Boolean);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with code ${result.status}`);
  }
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

function isMacTarget(target) {
  return /^node\d+-macos-/.test(target);
}

function currentPlatformMatchesTarget(target) {
  const match = /^node\d+-(macos|linux|win)-(x64|arm64)$/.exec(target);
  if (!match) return false;
  const targetPlatform = match[1] === "macos" ? "darwin" : match[1] === "win" ? "win32" : "linux";
  return process.platform === targetPlatform && process.arch === match[2];
}

function signMacBinary(file, target) {
  if (!isMacTarget(target)) return false;
  if (process.platform !== "darwin") {
    if (process.env.ANYENV_ALLOW_UNSIGNED_MACOS === "1") {
      console.warn(`warning: leaving ${path.basename(file)} unsigned because this is not macOS`);
      return false;
    }
    throw new Error("macOS CLI targets must be packaged on macOS so codesign can ad-hoc sign them. Set ANYENV_ALLOW_UNSIGNED_MACOS=1 only for local diagnostics.");
  }
  if (!isMachOBinary(file)) {
    throw new Error(`Refusing to sign non-Mach-O macOS binary: ${file}`);
  }
  run("codesign", ["--force", "--sign", "-", file], { shell: false });
  run("codesign", ["--verify", file], { shell: false });
  return true;
}

function smokeBinary(file) {
  const result = spawnSync(file, ["--version"], {
    cwd: root,
    stdio: "pipe",
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    throw new Error(`${file} --version failed with status ${result.status ?? result.signal}: ${(result.stderr || result.stdout || result.error?.message || "").trim()}`);
  }
  const version = String(result.stdout || result.stderr || "").trim().split(/\r?\n/)[0] || "";
  if (!/\d+\.\d+/.test(version)) {
    throw new Error(`${file} --version returned an unexpected version: ${version || "(empty)"}`);
  }
  return version;
}

function targetName(target) {
  const match = /^node\d+-(macos|linux|win)-(x64|arm64)$/.exec(target);
  if (!match) throw new Error(`Unsupported target: ${target}`);
  const os = match[1] === "macos" ? "darwin" : match[1] === "win" ? "windows" : match[1];
  const ext = os === "windows" ? ".exe" : "";
  return `anyenv-${os}-${match[2]}${ext}`;
}

run("npm", ["run", "bundle"]);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

for (const target of targets) {
  const output = path.join(outDir, targetName(target));
  run("npx", ["pkg", bundlePath, "--targets", target, "--output", output]);
  if (!output.endsWith(".exe")) fs.chmodSync(output, 0o755);
  const signed = signMacBinary(output, target);
  const smoked = currentPlatformMatchesTarget(target) ? smokeBinary(output) : "";
  const details = [
    signed ? "signed" : "",
    smoked ? `smoked ${smoked}` : "",
  ].filter(Boolean).join(", ");
  console.log(`created ${path.relative(root, output)}${details ? ` (${details})` : ""}`);
}

fs.writeFileSync(
  path.join(outDir, "VERSION"),
  `${pkgJson.version}\n`,
);
