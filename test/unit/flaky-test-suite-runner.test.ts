import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const runner = join(root, "scripts/run-flaky-test-suite.ts");

type Mode = "success" | "flake" | "persistent" | "deterministic" | "headroom" | "retry-headroom" | "quiet";

/**
 * Drive the wrapper over a scripted transcript.
 *
 * The scenarios need output no real suite could produce -- a 25 s sample, a
 * reporter that prints no durations at all -- but the guard reads a budget only
 * from a real `bun test` command. So the script that prints them is itself a Bun
 * test file run by `bun test`, and it exits once its transcript is written so
 * Bun appends none of its own records to it.
 */
async function fixture(mode: Mode, extraArgs: string[] = []): Promise<{ code: number; output: string; files: string[]; summary: string; durations: string }> {
  const dir = mkdtempSync(join(tmpdir(), "atomic-flake-runner-"));
  const counter = join(dir, "counter");
  const diagnostics = join(dir, "diagnostics");
  const summary = join(dir, "summary.md");
  writeFileSync(join(dir, "fixture.test.ts"), `
    import { test } from "bun:test";
    import { existsSync, readFileSync, writeFileSync } from "node:fs";
    test("fixture", () => {
      const counter = ${JSON.stringify(counter)};
      const attempt = existsSync(counter) ? Number(readFileSync(counter, "utf8")) + 1 : 1;
      writeFileSync(counter, String(attempt));
      console.log("fixture attempt " + attempt);
      const mode = ${JSON.stringify(mode)};
      if (mode === "flake") console.log("test/unit/ci-workflow-contracts.test.ts:\\n(pass) deterministic contract");
      if (mode === "headroom") console.log("test/unit/drift.test.ts:\\n(pass) drifting test [25000.00ms]\\n(pass) healthy test [120.00ms]");
      if (mode === "quiet") console.log(" 2 pass\\n 0 fail\\nRan 2 tests across 1 file. [134.00ms]");
      if (mode === "retry-headroom") {
        if (attempt === 1) {
          console.log("test/unit/drift.test.ts:\\n(pass) drifting test [25000.00ms]");
          console.error("test/unit/unrelated.test.ts:\\n(fail) unrelated failure");
          process.exit(7);
        }
        console.log("test/unit/drift.test.ts:\\n(pass) drifting test [120.00ms]");
      }
      if (mode === "persistent" || (mode === "flake" && attempt === 1)) { console.error("test/unit/unrelated.test.ts:\\n(fail) unrelated failure"); process.exit(7); }
      if (mode === "deterministic") { console.error("test/ci/ci-workflow-contracts.test.ts:\\n(fail) deterministic contract"); process.exit(8); }
      process.exit(0);
    });
  `);
  try {
    const processResult = Bun.spawn([
      "bun", runner, "--label", "fixture suite", "--diagnostics-dir", diagnostics,
      "--no-retry-file", "ci-workflow-contracts.test.ts", "--", "bun", "test", ...extraArgs, "fixture.test.ts",
    ], { cwd: dir, env: { ...process.env, GITHUB_STEP_SUMMARY: summary }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(processResult.stdout).text(),
      new Response(processResult.stderr).text(),
      processResult.exited,
    ]);
    const glob = new Bun.Glob("*");
    const files = await Array.fromAsync(glob.scan({ cwd: diagnostics, onlyFiles: true })).catch(() => []);
    const summaryText = await Bun.file(summary).exists() ? await Bun.file(summary).text() : "";
    const durationsPath = join(diagnostics, "fixture-suite-durations.md");
    const durations = await Bun.file(durationsPath).exists() ? await Bun.file(durationsPath).text() : "";
    return { code, output: stdout + stderr, files, summary: summaryText, durations };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("green suite exits immediately with only the duration table", async () => {
  const result = await fixture("success");
  assert.equal(result.code, 0);
  assert.deepEqual(result.files, ["fixture-suite-durations.md"]);
  assert.doesNotMatch(result.output, /Retrying/);
});
test("a passing no-retry file header does not suppress an unrelated flake retry", async () => {
  const result = await fixture("flake");
  assert.equal(result.code, 0);
  assert.match(result.output, /fixture attempt 1[\s\S]*fixture attempt 2/);
  assert.match(result.summary, /Detected flake/);
  assert.deepEqual(result.files.sort(), ["fixture-suite-attempt-1.log", "fixture-suite-attempt-2.log", "fixture-suite-debug.txt", "fixture-suite-durations.md"]);
});

test("persistent failure returns failure with both attempt logs", async () => {
  const result = await fixture("persistent");
  assert.equal(result.code, 7);
  assert.match(result.summary, /Persistent failure/);
  assert.match(result.output, /fixture attempt 1[\s\S]*fixture attempt 2/);
  assert.ok(result.files.includes("fixture-suite-attempt-1.log"));
  assert.ok(result.files.includes("fixture-suite-attempt-2.log"));
});

test("deterministic workflow contract failures are never retried", async () => {
  const result = await fixture("deterministic");
  assert.equal(result.code, 8);
  assert.match(result.output, /No retry: deterministic test file failed/);
  assert.doesNotMatch(result.output, /fixture attempt 2/);
  assert.ok(result.files.includes("fixture-suite-attempt-1.log"));
  assert.ok(!result.files.includes("fixture-suite-attempt-2.log"));
});

test("a green suite still fails when one test exhausts its timeout headroom", async () => {
  const gated = await fixture("headroom", ["--timeout", "30000"]);
  assert.equal(gated.code, 1);
  assert.match(gated.output, /::error title=Timeout headroom exhausted[\s\S]*drifting test took 25000ms of its 30000ms budget \(83%\)/);
  assert.doesNotMatch(gated.output, /::(?:warning|error)[^\n]*healthy test/);
  assert.match(gated.summary, /Timeout headroom exhausted/);
  assert.match(gated.durations, /drifting test/);
});

test("the headroom gate stays disabled for a suite that declares no timeout budget", async () => {
  const ungated = await fixture("headroom");
  assert.equal(ungated.code, 0);
  assert.doesNotMatch(ungated.output, /Timeout headroom exhausted/);
  assert.match(ungated.durations, /not declared \(gate disabled\)[\s\S]*drifting test/);
});

test("a passing retry cannot hide the failed attempt's exhausted headroom", async () => {
  const result = await fixture("retry-headroom", ["--timeout", "30000"]);
  assert.equal(result.code, 1);
  assert.match(
    result.output,
    /::error title=Timeout headroom exhausted[^\n]*attempt 1: test\/unit\/drift\.test\.ts > drifting test took 25000ms/,
  );
  assert.match(result.durations, /## attempt 1[\s\S]*25000[\s\S]*## attempt 2[\s\S]*120/);
  assert.match(result.summary, /Detected flake/);
});

/** Source of a real two-test Bun suite: one default budget, one explicit. */
const REAL_SUITE = [
  'import { test, expect } from "bun:test";',
  'test("inherits the suite budget", () => { expect(1).toBe(1); });',
  'test("declares its own budget", async () => {',
  "  await new Promise((resolve) => setTimeout(resolve, 30));",
  "}, 2_000);",
].join("\n");

/** Drive the real wrapper over a real Bun run in a scratch directory. */
async function realBunSuite(
  files: Record<string, string>,
  command: string[],
): Promise<{ code: number; output: string; durations: string }> {
  const dir = mkdtempSync(join(tmpdir(), "atomic-flake-real-"));
  const diagnostics = join(dir, "diagnostics");
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(dir, name), contents);
  try {
    const spawned = Bun.spawn(
      ["bun", runner, "--label", "real suite", "--diagnostics-dir", diagnostics, "--", ...command],
      {
        cwd: dir,
        // Both reporter conditions at once: agent-quiet must be neutralised for
        // the child, and Actions log groups must not corrupt the file path.
        env: { ...process.env, AGENT: "1", CLAUDECODE: "1", GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: undefined },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(spawned.stdout).text(),
      new Response(spawned.stderr).text(),
      spawned.exited,
    ]);
    return {
      code,
      output: stdout + stderr,
      durations: await Bun.file(join(diagnostics, "real-suite-durations.md")).text(),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Every real-Bun sample must carry the budget it was actually scored against. */
function assertScoredRealSuite(result: { code: number; output: string; durations: string }): void {
  assert.equal(result.code, 0, result.output);
  assert.doesNotMatch(result.output, /Duration guard blind/);
  assert.match(result.durations, /Samples: 2 of 2 test\(s\) run/);
  assert.match(result.durations, /\| 30000 ms \| suite\.test\.ts \| inherits the suite budget \|/);
  assert.match(result.durations, /\| 2000 ms \(explicit\) \| suite\.test\.ts \| declares its own budget \|/);
}

/**
 * The gate is only as good as the output it reads, so this exercises the real
 * Bun test runner through the real wrapper, in the two conditions that had
 * silently emptied it: Bun's agent-quiet reporter (which prints no per-test
 * records at all) and the Actions reporter (which wraps each file header in a
 * log group). A populated table with the explicit budget attached is the proof.
 */
test("the wrapper scores real Bun output under the agent-quiet and Actions reporters", async () => {
  assertScoredRealSuite(
    await realBunSuite({ "suite.test.ts": REAL_SUITE }, ["bun", "test", "--timeout", "30000", "suite.test.ts"]),
  );
});

/**
 * CI never invokes `bun test` directly -- every suite goes through `bun run
 * <script>`, where the budget lives in package.json and must be read back out
 * of it. Scoring that form against real Bun output closes the gap between what
 * the guard is unit-tested on and the command it is actually pointed at.
 */
test("the wrapper scores real Bun output behind the `bun run <script>` form CI uses", async () => {
  assertScoredRealSuite(
    await realBunSuite(
      {
        "suite.test.ts": REAL_SUITE,
        "package.json": JSON.stringify({ name: "real-suite", scripts: { "test:unit": "bun test --timeout 30000" } }),
      },
      ["bun", "run", "test:unit"],
    ),
  );
});

test("a suite whose tests ran without printing durations fails instead of passing blind", async () => {
  const result = await fixture("quiet", ["--timeout", "30000"]);
  assert.equal(result.code, 1);
  assert.match(result.output, /::error title=Duration guard blind[^\n]*2 test\(s\) ran but printed no per-test durations/);
  assert.match(result.summary, /Duration guard blind/);
  assert.match(result.durations, /Samples: 0 of 2 test\(s\) run/);
});
