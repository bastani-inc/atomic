import { test } from "bun:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { jobBlock, jobBlocks, jobSteps, namedStep, readText, stepIndex } from "./workflow-text.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const testPath = join(root, ".github/workflows/test.yml");

/** The work jobs the result gate must depend on, in file and `needs` order. */
const WORK_JOBS = ["suites", "agent-suite", "release-archive", "static-checks"] as const;

/** Job blocks keyed by job id, in file order. */
async function jobs(): Promise<Map<string, string>> {
  return new Map(jobBlocks(await readText(testPath)));
}

/**
 * The two required contexts of repository ruleset 9310196 are produced by the
 * `test` job's matrix and nothing else. Splitting work into new jobs silently
 * un-protects every step that leaves `test`, and a `needs:` job without
 * `if: always()` is *skipped* when a dependency fails — which GitHub counts as a
 * satisfied required check. This contract is the guard against both.
 */
test("the test job is a fail-closed result gate carrying both required contexts", async () => {
  const workflow = await readText(testPath);
  const gate = jobBlock(workflow, "test");
  assert.match(gate, /^[ \t]+name: test \(\$\{\{ matrix\.os \}\}, \$\{\{ matrix\.binary_platform \}\}\)$/mu);

  const contexts = [...gate.matchAll(/^[ \t]+- os: (\S+)\s+binary_platform: (\S+)$/gmu)]
    .map(([, os, platform]) => `test (${os}, ${platform})`);
  assert.deepEqual(contexts, [
    "test (blacksmith-4vcpu-ubuntu-2404, linux-x64)",
    "test (blacksmith-4vcpu-windows-2025, windows-x64)",
  ]);

  assert.match(gate, /^[ \t]+if: always\(\)$/mu, "a skipped required check counts as passed");
  assert.match(gate, new RegExp(`^[ \\t]+needs: \\[${WORK_JOBS.join(", ")}\\]$`, "mu"));

  const steps = jobSteps(gate);
  assert.equal(steps.length, 1, "the gate must do no work of its own");
  const guard = steps[0] as string;
  assert.match(guard, /join\(needs\.\*\.result, ','\)/u);
  assert.match(guard, /\*,failure,\*\|\*,cancelled,\*\|\*,skipped,\*/u);
  assert.match(guard, /exit 1/u);
  assert.doesNotMatch(guard, /checkout|setup-bun|bun run/u);
  // The gate is pure bookkeeping, so both legs run on Linux; a Windows runner
  // would add its measured 33s queue for nothing.
  assert.match(gate, /^[ \t]+runs-on: blacksmith-4vcpu-ubuntu-2404$/mu);
});

test("every work job the gate names exists and is otherwise independent", async () => {
  const blocks = await jobs();
  assert.deepEqual([...blocks.keys()], [...WORK_JOBS, "test"]);
  for (const job of WORK_JOBS) {
    const block = blocks.get(job) as string;
    assert.doesNotMatch(block, /^[ \t]+needs:/mu, `${job} must not serialize behind another job`);
  }
});

/**
 * Per-job wall-clock caps replace the blanket 10/15 minute pair. A cap is a hang
 * detector at roughly 2x measured p100 and must leave room for the one bounded
 * flake retry the job owns: the first split run fired that retry on both
 * platforms and took 230 s / 348 s in `suites` alone.
 */
test("each split job declares its own measured timeout", async () => {
  const workflow = await readText(testPath);
  const blocks = await jobs();
  const caps: Record<string, [number, number]> = {
    suites: [8, 12],
    "agent-suite": [6, 12],
    "release-archive": [5, 6],
  };
  for (const [job, [linux, windows]] of Object.entries(caps)) {
    const block = blocks.get(job) as string;
    assert.match(block, new RegExp(`blacksmith-4vcpu-ubuntu-2404\\s+binary_platform: linux-x64\\s+timeout_minutes: ${linux}`, "u"), job);
    assert.match(block, new RegExp(`blacksmith-4vcpu-windows-2025\\s+binary_platform: windows-x64\\s+timeout_minutes: ${windows}`, "u"), job);
    assert.match(block, /timeout-minutes: \$\{\{ matrix\.timeout_minutes \}\}/u, job);
    assert.match(block, /fail-fast: false/u, job);
  }
  assert.match(blocks.get("static-checks") as string, /^[ \t]+timeout-minutes: 6$/mu);
  assert.match(blocks.get("test") as string, /^[ \t]+timeout-minutes: 5$/mu);
  // The blanket per-platform pair covered fourteen sequential steps and detected
  // nothing about the step that actually hung. Every cap must also stay under
  // the 15-minute Windows blanket it replaced.
  assert.doesNotMatch(workflow, /timeout_minutes: (10|15)\b/u);
  for (const [, value] of workflow.matchAll(/^\s+timeout_minutes: (\d+)$/gmu)) {
    assert.ok(Number(value) < 15, `cap ${value} is no tighter than the blanket it replaced`);
  }
});

/**
 * Steps that consume a previous step's output stay in one job. Moving them apart
 * would not fail: test/unit/pi-0.82.1-artifacts.test.ts degrades to `test.skip`
 * without packages/coding-agent/dist, so the coverage would vanish quietly.
 */
test("build-consuming steps stay in the job that produced the build", async () => {
  const blocks = await jobs();

  const suites = jobSteps(blocks.get("suites") as string);
  assert.ok(stepIndex(suites, "Build @bastani/atomic package") < stepIndex(suites, "Unit tests"));
  assert.ok(stepIndex(suites, "Unit tests") < stepIndex(suites, "Integration tests"));
  assert.match(namedStep(suites, "Integration tests"), /ATOMIC_REQUIRE_INSTALLED_NODE_SMOKE: "1"/u);
  assert.match(blocks.get("suites") as string, /uses: actions\/setup-node@/u);
  assert.doesNotMatch(blocks.get("suites") as string, /rust-toolchain/u);

  const agent = jobSteps(blocks.get("agent-suite") as string);
  assert.ok(stepIndex(agent, "Build native bindings for package tests") < stepIndex(agent, "coding-agent vitest suite"));
  assert.match(namedStep(agent, "coding-agent vitest suite"), /ATOMIC_REQUIRE_NATIVE_BINDING_SMOKE: "1"/u);
  assert.match(blocks.get("agent-suite") as string, /uses: dtolnay\/rust-toolchain@/u);

  const archive = jobSteps(blocks.get("release-archive") as string);
  assert.ok(stepIndex(archive, "Build @bastani/atomic package") < stepIndex(archive, "Build native release binary"));
  assert.ok(stepIndex(archive, "Build native release binary") < stepIndex(archive, "Smoke test Linux release archive"));
  assert.ok(stepIndex(archive, "Build native release binary") < stepIndex(archive, "Smoke test Windows release archive"));
  // build-binaries.sh rebuilds packages/natives/native/*.node when they are
  // absent, so this job needs Rust rather than a dependency on agent-suite.
  assert.match(blocks.get("release-archive") as string, /uses: dtolnay\/rust-toolchain@/u);

  const staticChecks = blocks.get("static-checks") as string;
  assert.match(staticChecks, /^[ \t]+runs-on: blacksmith-4vcpu-ubuntu-2404$/mu);
  assert.doesNotMatch(staticChecks, /rust-toolchain|setup-node/u);
  for (const step of ["Typecheck", "File length check", "Docs link validation", "Mintlify docs validation", "Deterministic CI and release contracts"]) {
    namedStep(jobSteps(staticChecks), step);
  }
  assert.match(namedStep(jobSteps(staticChecks), "Deterministic CI and release contracts"), /run: bun run test:ci-contracts/u);
});

/**
 * `actions/upload-artifact@v4+` fails the entire run when two jobs upload the
 * same artifact name, and three jobs previously emitted the identical
 * `test-diagnostics-<platform>` name.
 */
test("every diagnostics upload has a job-unique artifact name", async () => {
  const uploads = [...(await jobs())].flatMap(([job, block]) =>
    jobSteps(block)
      .filter((step) => step.includes("actions/upload-artifact@"))
      .map((step) => {
        const name = /^\s+name: (.+)$/mu.exec(step);
        assert.ok(name, `${job}: upload-artifact step declares no artifact name`);
        return (name[1] as string).trim();
      }));
  assert.ok(uploads.length >= 2, "the flaky-suite jobs must still preserve their diagnostics");
  assert.equal(new Set(uploads).size, uploads.length, `duplicate artifact names: ${uploads.join(", ")}`);
  for (const name of uploads) assert.match(name, /^test-diagnostics-[a-z-]+-\$\{\{ matrix\.binary_platform \}\}$/u);
});

/**
 * The duration-headroom guard parses Bun's per-test `(pass) name [Nms]` records.
 * Every suite must keep reaching it through an unmodified `bun run <script>`
 * command: a bare `bun test` or an added `--parallel` would change the records
 * the guard scores, and `--parallel` re-executes tests imported by an aggregator
 * file so healthy tests get scored twice, once under contention.
 */
test("every retried suite still runs through the duration guard unmodified", async () => {
  const workflow = await readText(testPath);
  const invocations = [...workflow.matchAll(/-- (bun run [^\n]+)$/gmu)].map(([, command]) => (command as string).trim());
  assert.deepEqual(invocations, [
    "bun run test:unit",
    "bun run test:integration",
    "bun run --cwd packages/coding-agent --bun test",
  ]);
  assert.equal(workflow.split("run-flaky-test-suite.ts").length - 1, invocations.length);
  assert.doesNotMatch(workflow, /--parallel|--shard|--concurrent|--max-concurrency/u);
});

/**
 * `bun run test:ci-contracts` used to run on both platforms; it now runs only in
 * the Linux-only static-checks job. The one thing the Windows leg contributed
 * was a CRLF checkout, which `.gitattributes` now forecloses by pinning `*.yml`
 * to `eol=lf`. Routing every workflow read through the newline-normalizing
 * reader keeps that trap closed from the test side too, so neither a relaxed
 * attribute nor a stray CRLF can quietly change what these patterns match.
 */
test("CI contract suites read workflow text through the normalizing reader", async () => {
  const dir = join(root, "test/ci");
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".ts") || entry === "workflow-text.ts") continue;
    const source = await readText(join(dir, entry));
    assert.doesNotMatch(
      source,
      /Bun\.file\([^)]*\)\.text\(\)/u,
      `${entry}: read workflow text with readText() so a CRLF checkout cannot change the match`,
    );
  }
});
