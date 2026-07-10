import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { McpSessionCleanupBarrier } from "../../packages/mcp/session-cleanup-barrier.js";

const repoRoot = resolve(import.meta.dir, "../..");

test("cleanup deadline does not let a never-settling task poison later generations", async () => {
  const barrier = new McpSessionCleanupBarrier(10);
  const never = new Promise<void>(() => undefined);
  await barrier.retain([never]);
  const started = performance.now();
  await barrier.retain([Promise.resolve()]);
  assert.equal(performance.now() - started < 50, true);
});

test("a replacement session waits for the retired initializer and its cleanup before starting", () => {
  const fixtureDir = mkdtempSync(join(repoRoot, ".mcp-cleanup-barrier-"));
  try {
    writeFileSync(join(fixtureDir, "package.json"), JSON.stringify({ type: "module" }));
    for (const file of ["index.ts", "caller-wait.ts", "session-cleanup-barrier.ts", "state-lease.ts", "command-registration.ts"]) {
      writeFileSync(join(fixtureDir, file), readFileSync(join(repoRoot, "packages/mcp", file), "utf8"));
    }
    writeFileSync(join(fixtureDir, "config.ts"), `export function loadMcpConfig() { return { mcpServers: {} }; }\n`);
    writeFileSync(join(fixtureDir, "utils.ts"), `export function getConfigPathFromArgv() { return undefined; }\n`);
    writeFileSync(join(fixtureDir, "tool-result-renderer.ts"), `export function renderMcpToolResult() {}\n`);
    writeFileSync(join(fixtureDir, "metadata-cache.ts"), `export function loadMetadataCache() { return null; }\n`);
    writeFileSync(join(fixtureDir, "direct-tools.ts"), `
export function resolveDirectTools() { return []; }
export function getMissingConfiguredDirectToolServers() { return []; }
export function createDirectToolExecutor() { return async () => ({ content: [], details: {} }); }
`);
    writeFileSync(join(fixtureDir, "startup-warmup.ts"), `export function scheduleMcpStartupWarmup() { return { cancel() {} }; }\n`);
    writeFileSync(join(fixtureDir, "mcp-auth-flow.ts"), `
let resets = 0;
export async function shutdownOAuth(reason) {
  resets += 1;
  globalThis.events.push("oauth-reset:" + reason + ":" + resets);
  if (resets === 2) await globalThis.oldOAuthResetGate;
}
`);
    writeFileSync(join(fixtureDir, "proxy-modes.ts"), `
export async function executeStatus() { return { content: [], details: {} }; }
export const executeCall = executeStatus, executeConnect = executeStatus, executeDescribe = executeStatus,
  executeList = executeStatus, executeSearch = executeStatus, executeUiMessages = executeStatus;
`);
    writeFileSync(join(fixtureDir, "init.ts"), `
let attempts = 0;
export async function initializeMcp() {
  attempts += 1;
  globalThis.events.push("init:" + attempts);
  if (attempts === 1) await globalThis.oldInitGate;
  const generation = attempts;
  return {
    config: { mcpServers: {} }, toolMetadata: new Map(), failureTracker: new Map(), uiServer: null,
    lifecycle: { async gracefulShutdown() {
      globalThis.events.push("cleanup:" + generation);
      if (generation === 1) await globalThis.oldCleanupGate;
    } },
  };
}
export function updateStatusBar() {}
export function flushMetadataCache() {}
`);

    const extensionUrl = pathToFileURL(join(fixtureDir, "index.ts")).href;
    const script = `
const events = globalThis.events = [];
let releaseOldInit;
globalThis.oldInitGate = new Promise((resolve) => { releaseOldInit = resolve; });
let releaseOldCleanup;
globalThis.oldCleanupGate = new Promise((resolve) => { releaseOldCleanup = resolve; });
let releaseOldOAuthReset;
globalThis.oldOAuthResetGate = new Promise((resolve) => { releaseOldOAuthReset = resolve; });
const waitFor = async (label, predicate) => {
  const deadline = performance.now() + 2000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("Timed out waiting for " + label);
    await Bun.sleep(1);
  }
};
const { default: mcpAdapter } = await import(${JSON.stringify(extensionUrl)});
const handlers = new Map();
const api = {
  registerFlag() {}, registerCommand() {}, registerTool() {}, registerShortcut() {}, registerMessageRenderer() {},
  getAllTools() { return []; }, getFlag() { return undefined; }, refreshTools() {},
  on(event, handler) { handlers.set(event, handler); },
};
const firstCtx = { cwd: ${JSON.stringify(repoRoot)}, hasUI: false };
const secondCtx = { cwd: ${JSON.stringify(repoRoot)}, hasUI: false };
mcpAdapter(api);
await handlers.get("session_start")({}, firstCtx);
await waitFor("first initializer", () => events.includes("init:1"));
const replacementStart = handlers.get("session_start")({}, secondCtx);
await Bun.sleep(5);
const beforeRelease = [...events];
releaseOldInit();
await waitFor("old cleanup", () => events.includes("cleanup:1"));
const duringCleanup = [...events];
releaseOldCleanup();
await Bun.sleep(5);
const beforeOAuthRelease = [...events];
releaseOldOAuthReset();
await replacementStart;
await waitFor("replacement initializer", () => events.includes("init:2"));
await handlers.get("session_shutdown")({}, secondCtx);
console.log(JSON.stringify({ beforeRelease, duringCleanup, beforeOAuthRelease, events }));
`;
    const result = spawnSync("bun", ["--eval", script], { cwd: repoRoot, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as {
      beforeRelease: string[]; duringCleanup: string[]; beforeOAuthRelease: string[]; events: string[];
    };
    assert.deepEqual(output.beforeRelease, [
      "oauth-reset:session_restart:1", "init:1", "oauth-reset:session_restart:2",
    ]);
    assert.deepEqual(output.duringCleanup, [
      "oauth-reset:session_restart:1", "init:1", "oauth-reset:session_restart:2", "cleanup:1",
    ]);
    assert.deepEqual(output.beforeOAuthRelease, output.duringCleanup);
    assert.equal(output.events.indexOf("init:2") > output.events.indexOf("oauth-reset:session_restart:2"), true);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
