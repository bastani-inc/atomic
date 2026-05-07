/**
 * Integration tests for custom-workflows / hostLocalWorkflows end-to-end.
 *
 * Uses the real SDK fixture at tests/fixtures/sdk-host-consumer/index.ts
 * to exercise the full spawn-parse cycle that the production loader
 * (loadCustomWorkflows) drives, as well as two direct-spawn paths that
 * exercise hostLocalWorkflows() behaviour:
 *   1. _emit-workflow-meta with valid token  → ATOMIC_WORKFLOW_META emitted
 *   2. no env tokens                         → user main() runs, no meta
 *   3. _atomic-run --detach                  → exit 0 (creates tmux session)
 *
 * Test 3 uses --detach because the foreground attach path calls
 * `tmux switch-client`, which requires an active tmux client and therefore
 * fails in a plain terminal test harness.  The detach path creates the
 * session and exits 0 without attaching.
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { loadCustomWorkflows } from "./custom-workflows.ts";

// ─── Timeout env override ─────────────────────────────────────────────────────

// Bun's cold TS resolution + workspace dep chain can exceed the production 5s
// default under `bun test --parallel` cold caches; production users on warm
// caches are unaffected.
let _priorMetaTimeout: string | undefined;
beforeAll(() => {
  _priorMetaTimeout = process.env.ATOMIC_WORKFLOWS_META_TIMEOUT_MS;
  process.env.ATOMIC_WORKFLOWS_META_TIMEOUT_MS = "15000";
});
afterAll(() => {
  if (_priorMetaTimeout === undefined) {
    delete process.env.ATOMIC_WORKFLOWS_META_TIMEOUT_MS;
  } else {
    process.env.ATOMIC_WORKFLOWS_META_TIMEOUT_MS = _priorMetaTimeout;
  }
});

// ─── Fixture path ─────────────────────────────────────────────────────────────

// import.meta.dir = packages/atomic/src/commands
// ../../../../          = repo root
const FIXTURE_DIR = path.resolve(import.meta.dir, "../../../../tests/fixtures/sdk-host-consumer");
const FIXTURE_ENTRY = path.join(FIXTURE_DIR, "index.ts");

// ─── CLI path for subprocess tests ────────────────────────────────────────────
const CLI_PATH = path.resolve(import.meta.dir, "../cli.ts");

// ─── Test 1: loadCustomWorkflows discovers the real SDK fixture ───────────────

test("loadCustomWorkflows spawns sdk-host-consumer fixture and discovers compiled workflow", async () => {
  const result = await loadCustomWorkflows(
    {
      "demo-wf": {
        command: "bun",
        args: ["run", FIXTURE_ENTRY],
        agents: ["claude"],
      },
    },
    "local",
    "<settings-path-stub>",
  );

  expect(result.loaded).toHaveLength(1);
  expect(result.loaded[0]!.alias).toBe("demo-wf");
  expect(result.loaded[0]!.workflow.name).toBe("demo-wf");
  expect(result.loaded[0]!.workflow.agent).toBe("claude");
  expect(result.broken).toHaveLength(0);
}, 30000);

// ─── Test 2: no env tokens → user main runs, no meta emitted ─────────────────

test("fixture invoked directly without atomic env runs user main(); does not emit meta", async () => {
  const child = Bun.spawn(
    ["bun", "run", FIXTURE_ENTRY, "_emit-workflow-meta"],
    {
      stdout: "pipe",
      stderr: "pipe",
      // Deliberately exclude ATOMIC_HOST and ATOMIC_DISPATCH_TOKEN
      env: { PATH: process.env.PATH ?? "" },
    },
  );

  const stdout = await new Response(child.stdout).text();
  await child.exited;

  expect(stdout).not.toContain("ATOMIC_WORKFLOW_META:");
  expect(stdout).toContain("user main ran");
}, 30000);

// ─── Test 2b: RFC §8.3 token-isolation — dispatch-token in argv but no env tokens ──────────────

test("RFC §8.3: fixture invoked with _emit-workflow-meta and --dispatch-token but no env tokens falls through to user main(); no meta emitted", async () => {
  const token = "a".repeat(32);
  const child = Bun.spawn(
    [
      "bun", "run", FIXTURE_ENTRY,
      "_emit-workflow-meta",
      `--dispatch-token=${token}`,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      // Deliberately exclude ATOMIC_HOST and ATOMIC_DISPATCH_TOKEN from env
      env: { PATH: process.env.PATH ?? "" },
    },
  );

  const stdout = await new Response(child.stdout).text();
  const exitCode = await child.exited;

  // Exit 0: consumer's own main() ran to completion
  expect(exitCode).toBe(0);
  // No meta line emitted — token-gating blocked dispatch
  expect(stdout.split("\n").some((l) => l.startsWith("ATOMIC_WORKFLOW_META: "))).toBe(false);
  // Consumer's standalone print confirms user main() executed
  expect(stdout).toContain("user main ran");
}, 30000);

// ─── Test 2c: RFC §8.3 symmetry — valid env tokens + matching dispatch-token → meta emitted ──

test("RFC §8.3 symmetry: fixture invoked with _emit-workflow-meta and valid env tokens emits ATOMIC_WORKFLOW_META line", async () => {
  const token = "b".repeat(32);
  const child = Bun.spawn(
    [
      "bun", "run", FIXTURE_ENTRY,
      "_emit-workflow-meta",
      `--dispatch-token=${token}`,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: process.env.PATH ?? "",
        ATOMIC_HOST: "1",
        ATOMIC_DISPATCH_TOKEN: token,
      },
    },
  );

  const stdout = await new Response(child.stdout).text();
  const exitCode = await child.exited;

  // Exits 0 after emitting meta (process.exit(0) in hostLocalWorkflows)
  expect(exitCode).toBe(0);
  // Must contain the meta sentinel line
  const metaLine = stdout.split("\n").find((l) => l.startsWith("ATOMIC_WORKFLOW_META: "));
  expect(metaLine).toBeDefined();
  // The JSON payload must include the demo-wf workflow definition
  const payload = JSON.parse(metaLine!.slice("ATOMIC_WORKFLOW_META: ".length)) as unknown[];
  expect(Array.isArray(payload)).toBe(true);
  expect(payload.length).toBeGreaterThan(0);
  const first = payload[0] as Record<string, unknown>;
  expect(first["name"]).toBe("demo-wf");
  expect(first["agent"]).toBe("claude");
}, 30000);

// ─── Test 3: _atomic-run --detach path exits 0 ────────────────────────────────

test("hostLocalWorkflows _atomic-run --detach path creates tmux session and exits 0", async () => {
  // The foreground _atomic-run path calls `tmux switch-client` which requires
  // an active tmux client.  Using --detach avoids the attach step so the
  // process can exit cleanly in a plain terminal harness.
  const token = "a".repeat(32);
  const child = Bun.spawn(
    [
      "bun", "run", FIXTURE_ENTRY,
      "_atomic-run",
      `--dispatch-token=${token}`,
      "--name", "demo-wf",
      "--agent", "claude",
      "--detach",
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: process.env.PATH ?? "",
        ATOMIC_HOST: "1",
        ATOMIC_DISPATCH_TOKEN: token,
      },
    },
  );

  const exitCode = await child.exited;
  expect(exitCode).toBe(0);
}, 30000);

// ─── Test 4: _runtime-assets-smoke skips workflow bootstrap ───────────────────

test("_runtime-assets-smoke exits 0 and does not trigger workflow bootstrap even with broken workflow entry", async () => {
  // Write a settings.json whose workflow command crashes with exit 7 and never
  // emits the ATOMIC_WORKFLOW_META line. If the bootstrap were NOT skipped,
  // the loader would spawn this command, fail to parse meta, and emit
  // [atomic/workflows] diagnostics to stderr. The skip predicate must prevent
  // that entirely.
  const tmpHome = await mkdtemp(path.join(tmpdir(), "atomic-smoke-test-home-"));
  const tmpCwd = await mkdtemp(path.join(tmpdir(), "atomic-smoke-test-cwd-"));
  try {
    await mkdir(path.join(tmpHome, ".atomic"), { recursive: true });
    await mkdir(path.join(tmpCwd, ".atomic"), { recursive: true });
    await writeFile(
      path.join(tmpHome, ".atomic", "settings.json"),
      JSON.stringify({
        workflows: {
          "crash-wf": {
            command: "/bin/sh",
            args: ["-c", "exit 7"],
            agents: ["claude"],
          },
        },
      }),
    );

    const child = Bun.spawn(
      ["bun", CLI_PATH, "_runtime-assets-smoke"],
      {
        stdout: "pipe",
        stderr: "pipe",
        cwd: tmpCwd,
        env: {
          ...process.env,
          ATOMIC_SETTINGS_HOME: tmpHome,
          ATOMIC_SKIP_AUTOSYNC: "1",
        },
      },
    );

    const [stderr] = await Promise.all([
      new Response(child.stderr as ReadableStream<Uint8Array>).text(),
      new Response(child.stdout as ReadableStream<Uint8Array>).text(),
    ]);
    const exitCode = await child.exited;

    // Command must exit 0 (smoke check may report individual asset failures
    // but always exits cleanly)
    expect(exitCode).toBe(0);

    // No workflow bootstrap diagnostics — bootstrap was skipped
    expect(stderr).not.toContain("[atomic/workflows]");
  } finally {
    await rm(tmpHome, { recursive: true, force: true });
    await rm(tmpCwd, { recursive: true, force: true });
  }
}, 30000);
