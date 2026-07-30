import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const runner = join(root, "scripts/run-flaky-test-suite.ts");

type Mode = "success" | "flake" | "persistent" | "deterministic" | "headroom" | "retry-headroom";

async function fixture(mode: Mode, extraArgs: string[] = []): Promise<{ code: number; output: string; files: string[]; summary: string; durations: string }> {
  const dir = mkdtempSync(join(tmpdir(), "atomic-flake-runner-"));
  const command = join(dir, "fixture.ts");
  const counter = join(dir, "counter");
  const diagnostics = join(dir, "diagnostics");
  const summary = join(dir, "summary.md");
  writeFileSync(command, `
    import { existsSync, readFileSync, writeFileSync } from "node:fs";
    const counter = ${JSON.stringify(counter)};
    const attempt = existsSync(counter) ? Number(readFileSync(counter, "utf8")) + 1 : 1;
    writeFileSync(counter, String(attempt));
    console.log("fixture attempt " + attempt);
    const mode = ${JSON.stringify(mode)};
    if (mode === "flake") console.log("test/unit/ci-workflow-contracts.test.ts:\\n(pass) deterministic contract");
    if (mode === "headroom") console.log("test/unit/drift.test.ts:\\n(pass) drifting test [25000.00ms]\\n(pass) healthy test [120.00ms]");
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
  `);
  try {
    const processResult = Bun.spawn([
      "bun", runner, "--label", "fixture suite", "--diagnostics-dir", diagnostics,
      "--no-retry-file", "ci-workflow-contracts.test.ts", "--", "bun", command, ...extraArgs,
    ], { cwd: root, env: { ...process.env, GITHUB_STEP_SUMMARY: summary }, stdout: "pipe", stderr: "pipe" });
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
