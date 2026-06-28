import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { maskToken, normalizeApiBase, parseSyncItems, readProjectContext, resolveConfig, shellQuote, writeProjectContext } from "../lib/config.js";
import { resolveCurrentCliCommand } from "../lib/daemon.js";

test("normalizeApiBase accepts origins and api roots", () => {
  assert.equal(normalizeApiBase("http://localhost:36732"), "http://localhost:36732/api/v1");
  assert.equal(normalizeApiBase("http://localhost:36732/api"), "http://localhost:36732/api/v1");
  assert.equal(normalizeApiBase("http://localhost:36732/api/v1/"), "http://localhost:36732/api/v1");
});

test("parseSyncItems deduplicates comma lists", () => {
  assert.deepEqual(parseSyncItems("memory,knowledge,memory,tools"), ["memory", "knowledge", "tools"]);
});

test("maskToken hides project token middle", () => {
  assert.equal(maskToken("pt_abcdefghijklmnopqrstuvwxyz"), "pt_****...wxyz");
});

test("resolveConfig supports global token and project context", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-config-test-"));
  const config = path.join(dir, "config.json");
  const cwd = path.join(dir, "workspace");
  fs.mkdirSync(cwd);
  process.env.ANYENV_CONFIG = config;
  try {
    writeProjectContext("soulmate", cwd);
    const context = readProjectContext(cwd);
    assert.equal(context.projectId, "soulmate");
    const resolved = resolveConfig({
      cwd,
      "global-token": "evls_gt_abcdefghijklmnopqrstuvwxyz",
    });
    assert.equal(resolved.globalToken, "evls_gt_abcdefghijklmnopqrstuvwxyz");
    assert.equal(resolved.projectToken, "");
    assert.equal(resolved.projectId, "soulmate");
    assert.ok(resolved.projectContextPath.endsWith(path.join(".anyenv", "project.json")));
  } finally {
    delete process.env.ANYENV_CONFIG;
  }
});

test("shellQuote escapes single quotes", () => {
  assert.equal(shellQuote("anyenv user's CLI"), "'anyenv user'\\''s CLI'");
});

test("daemon command resolver reruns packaged executable when argv entry is a subcommand", () => {
  assert.deepEqual(
    resolveCurrentCliCommand(["/Users/me/.local/bin/anyenv", "start", "--workspace", "."], "/usr/local/bin/node", false),
    { command: "/Users/me/.local/bin/anyenv", prefixArgs: [] },
  );
});

test("daemon command resolver keeps node script entrypoint during source tests", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anyenv-config-test-"));
  const entry = path.join(dir, "anyenv.js");
  fs.writeFileSync(entry, "");
  assert.deepEqual(
    resolveCurrentCliCommand(["/usr/local/bin/node", entry, "start"], "/usr/local/bin/node", false),
    { command: "/usr/local/bin/node", prefixArgs: [entry] },
  );
});
