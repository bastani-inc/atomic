/**
 * E2E tests for the runtime half of #898.
 *
 * Isolation strategy (RFC §5.4): both tests spawn child Bun processes via
 * Bun.spawn(). The parent `bun test` process never registers a global
 * Bun.plugin(). This is mandatory: any test that calls
 * ensureRuntimePluginSupport, createRuntimePlugin, or installs a global
 * Bun.plugin() must do so inside a Bun.spawn child so the process-global
 * plugin state does not leak into subsequent tests in the same bun test
 * process. In particular, the onResolve hook registered by
 * ensureRuntimePluginSupport rewrites @opentui/core specifiers, which causes
 * Bun.build() calls in runtime-plugin.integration.test.ts to fail because
 * Bun.build() does not honor build.module() — the leak would poison those
 * tests.
 */

import { test, expect, describe, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

describe("auto-dispatch runtime-plugin e2e", () => {
  test(
    "capsule with rewritten @opentui/core specifier imports host's module",
    async () => {
      const fixturePath = new URL(
        "./__fixtures__/runtime-plugin-e2e-child.ts",
        import.meta.url,
      ).pathname;
      const proc = Bun.spawn(["bun", fixturePath], { stdout: "pipe", stderr: "pipe" });
      const exitCode = await proc.exited;
      const stderr = await new Response(proc.stderr).text();
      if (exitCode !== 0) throw new Error(`e2e child failed:\n${stderr}`);
      expect(exitCode).toBe(0);
    },
  );

  test(
    "auto-dispatch import does NOT attach global Bun plugin in non-orchestrator argv (regression: sync require still works)",
    async () => {
      // Fixture argv lacks "_orchestrator-entry", so auto-dispatch must skip
      // ensureRuntimePluginSupport. If it doesn't, the fixture's sync require
      // of ../components/layout.ts throws "TypeError: require() async module
      // ... is unsupported". Spawning a fresh process keeps the check honest
      // regardless of what other tests in the bun test process have loaded.
      const fixturePath = new URL(
        "./__fixtures__/non-orchestrator-sync-require.ts",
        import.meta.url,
      ).pathname;
      const proc = Bun.spawn(["bun", fixturePath], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      const stderr = await new Response(proc.stderr).text();
      if (exitCode !== 0) {
        throw new Error(
          `Regression detected: sync require() broke in non-orchestrator argv.\n${stderr}`,
        );
      }
      expect(exitCode).toBe(0);
    },
  );

  // ─── Re-entry guard (iteration-5) ──────────────────────────────────────────
  //
  // Tracks a tmp dir created during this test block. Cleaned up in afterAll.
  let reentryTmpDir: string | undefined;

  afterAll(async () => {
    if (reentryTmpDir) {
      await rm(reentryTmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test(
    "realistic capsule built with external: [\"@opentui/*\"] survives orchestrator-entry re-entry",
    async () => {
      // ── Setup: build two capsules from the same source ──────────────────
      // Two separate Bun.build outputs → two distinct resolved paths → two
      // independent module instances → two separate auto-dispatch.ts TLA
      // executions in the harness child process.
      //
      // Tmp dir lives INSIDE the workspace so the bundled `@opentui/core`
      // import (reached transitively via the SDK's static graph in the
      // capsule) walks up from the capsule's location into the workspace's
      // `node_modules` tree at runtime. A tmp dir under `os.tmpdir()` has
      // no walk-up path to `node_modules`, which makes the capsule's eager
      // `@opentui/core` import fail with ENOENT before the bundled
      // `auto-dispatch.ts` can install the runtime plugin.
      const workspaceTmp = new URL(
        "./__fixtures__/.tmp-reentry/",
        import.meta.url,
      ).pathname;
      await mkdir(workspaceTmp, { recursive: true });
      const tmpDir = await mkdtemp(join(workspaceTmp, "atomic-reentry-"));
      reentryTmpDir = tmpDir;

      // Write a tiny "no-workflow" dummy source that the bundled auto-dispatch
      // will import as the _orchestrator-entry "source" arg. It has no
      // WorkflowDefinition default, so resolveWorkflowDefinition throws
      // InvalidWorkflowError — silently caught, process does NOT exit(1).
      const noWfSourcePath = join(tmpDir, "no-wf.ts");
      await writeFile(noWfSourcePath, "export const noop = true;\n", "utf8");

      // Build capsule1 into outdir1 and capsule2 into outdir2 — done INSIDE the
      // harness child (RFC §5.4) to avoid cross-pollinating Bun's loader cache
      // with the parent bun test process that may have already warmed modules
      // from orchestrator-entry.resolve.test.ts.
      const capsuleSourcePath = new URL(
        "./__fixtures__/reentry-test-capsule-source.ts",
        import.meta.url,
      ).pathname;

      const outdir1 = join(tmpDir, "cap1");
      const outdir2 = join(tmpDir, "cap2");

      // ── Spawn harness child ──────────────────────────────────────────────
      const harnessPath = new URL(
        "./__fixtures__/realistic-capsule-reentry-child.ts",
        import.meta.url,
      ).pathname;

      const child = Bun.spawn({
        cmd: ["bun", harnessPath, capsuleSourcePath, outdir1, outdir2, noWfSourcePath],
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ATOMIC_DEBUG: "1" },
      });

      await child.exited;
      const stderr = await new Response(child.stderr).text();

      // ── Assertions ───────────────────────────────────────────────────────
      //
      // The iteration-4 P0 must NEVER appear, regardless of exit code. The
      // sentinel guard MUST have produced "skipped install" at least once —
      // proof the second bundled auto-dispatch.ts TLA short-circuited. The
      // first install must have logged "registered core loader" exactly once.
      // Exit code itself is informational: non-zero is tolerable when the
      // sentinel demonstrably fired (the assertion below covers that case).
      const identityAssertionError =
        "OpenTUI Core runtime plugin support is already installed with a different core runtime module.";
      const registeredMsg =
        "[atomic-sdk:runtime-plugin] registered core loader (orchestrator-entry)";
      const skippedMsg =
        "[atomic-sdk:runtime-plugin] skipped install (already present)";

      expect(stderr.includes(identityAssertionError)).toBe(false);
      expect(stderr.includes(skippedMsg)).toBe(true);
      expect(stderr.split(registeredMsg).length - 1).toBe(1);
    },
    // Build + spawn is slower than a typical unit test; allow up to 60 s.
    60_000,
  );
});
