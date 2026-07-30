import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  declaredTimeouts,
  evaluateDurations,
  FAIL_RATIO,
  parseTestDurations,
  renderDurationTable,
  resolveDefaultTimeoutMs,
  WARN_RATIO,
} from "../../scripts/test-duration-guard.js";

const root = fileURLToPath(new URL("../..", import.meta.url));

const BUN_OUTPUT = [
  "bun test v1.3.14 (0d9b296a)",
  "",
  "test/unit/alpha.test.ts:",
  "(pass) group > quick assertion [0.28ms]",
  "(fail) group > slow child process [5001.10ms]",
  "(skip) group > skipped case",
  "",
  "test/unit/beta.test.ts:",
  "\u001b[32m(pass)\u001b[0m loads builtin pi package resources [10672.00ms]",
  "",
  " 2 pass",
  " 1 fail",
  "Ran 3 tests across 2 files. [38.00ms]",
].join("\n");

test("duration parsing attributes each sample to its file and ignores non-test lines", () => {
  const samples = parseTestDurations(BUN_OUTPUT);
  assert.deepEqual(
    samples.map((sample) => [sample.file, sample.name, sample.status, sample.durationMs]),
    [
      ["test/unit/alpha.test.ts", "quick assertion", "pass", 0.28],
      ["test/unit/alpha.test.ts", "slow child process", "fail", 5001.1],
      ["test/unit/beta.test.ts", "loads builtin pi package resources", "pass", 10672],
    ],
  );
  assert.deepEqual(parseTestDurations("Ran 3 tests across 2 files. [38.00ms]"), []);
  assert.equal(parseTestDurations("test\\unit\\win.test.ts:\n(pass) a [1ms]")[0]?.file, "test/unit/win.test.ts");
});

test("explicit timeouts are resolved from both declaration shapes and never from nested callbacks", () => {
  const source = [
    "const fullLoadMs = 60_000;",
    'test("inline explicit", async () => {',
    "  await poll(() => {",
    "    ready();",
    "  }, 700);",
    "}, 20_000);",
    "",
    'test("named constant", async () => {',
    "}, fullLoadMs);",
    "",
    "const runTest = built ? test : test.skip;",
    "runTest(",
    '  "multi-line trailing argument",',
    "  async () => {",
    "    work();",
    "  },",
    "  240_000,",
    ");",
    "",
    'test("plain default", () => {',
    "});",
    "",
    'test("action=\'run\' keeps inner quotes", () => {',
    "}, 15_000);",
  ].join("\n");
  assert.deepEqual(
    [...declaredTimeouts(source).entries()].sort(),
    [
      ["action='run' keeps inner quotes", 15_000],
      ["inline explicit", 20_000],
      ["multi-line trailing argument", 240_000],
      ["named constant", 60_000],
    ],
  );
});

test("same-named tests in different describe scopes keep their own explicit budgets", () => {
  const source = [
    'describe("outer", () => {',
    '  test("shared", async () => {',
    "  }, 1_000);",
    "});",
    "",
    'describe("other", () => {',
    '  describe("nested", () => {',
    '    test("shared", async () => {',
    "    }, 10_000);",
    "  });",
    "});",
  ].join("\n");
  const declared = declaredTimeouts(source);
  assert.equal(declared.get("outer > shared"), 1_000);
  assert.equal(declared.get("other > nested > shared"), 10_000);

  const directory = mkdtempSync(join(tmpdir(), "atomic-duration-scope-"));
  try {
    writeFileSync(join(directory, "package.json"), JSON.stringify({ scripts: { "test:unit": "bun test --timeout 30000 test/unit" } }));
    writeFileSync(join(directory, "scoped.test.ts"), source);
    const report = evaluateDurations(
      ["scoped.test.ts:", "(pass) outer > shared [900.00ms]", "(pass) other > nested > shared [900.00ms]"].join("\n"),
      ["bun", "run", "test:unit"],
      directory,
    );
    assert.deepEqual(report.samples.map((sample) => sample.timeoutMs), [1_000, 10_000]);
    assert.deepEqual(report.failures.map((sample) => sample.fullName), ["outer > shared"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("repository declarations resolve to their real budgets", async () => {
  const builtins = declaredTimeouts(await Bun.file(join(root, "test/unit/coding-agent-builtin-workflows.test.ts")).text());
  assert.equal(builtins.get("loads builtin pi package resources"), 60_000);
  const installed = declaredTimeouts(await Bun.file(join(root, "test/integration/installed-package-node-extensions.test.ts")).text());
  assert.equal(installed.get("installed @bastani/atomic loads builtin extensions under Node"), 240_000);
  const notification = declaredTimeouts(await Bun.file(join(root, "test/unit/subagents-notification-content.test.ts")).text());
  assert.equal(notification.size, 0, "no test may restate the suite default as an explicit lower budget");
});

test("the suite budget is read from the command or the package script it runs", () => {
  assert.equal(resolveDefaultTimeoutMs(["bun", "test", "--timeout", "30000", "test/unit"], root), 30_000);
  assert.equal(resolveDefaultTimeoutMs(["bun", "test", "--timeout=45000"], root), 45_000);
  assert.equal(resolveDefaultTimeoutMs(["bun", "run", "test:unit"], root), 30_000);
  assert.equal(resolveDefaultTimeoutMs(["bun", "run", "test:integration"], root), 30_000);
  assert.equal(resolveDefaultTimeoutMs(["bun", "run", "test:ci-contracts"], root), 30_000);
  assert.equal(resolveDefaultTimeoutMs(["bun", "run", "typecheck"], root), undefined);
  assert.equal(resolveDefaultTimeoutMs(["bun", "run", "--cwd", "packages/coding-agent", "--bun", "test"], root), undefined);
  assert.equal(resolveDefaultTimeoutMs(["bun", "fixture.ts"], root), undefined);
  assert.equal(resolveDefaultTimeoutMs(["node", "scripts/migrate.mjs", "--timeout", "10000"], root), undefined);
  assert.equal(resolveDefaultTimeoutMs(["vitest", "run", "--timeout=10000"], root), undefined);
});

test("headroom is scored against the effective timeout, not a fixed ceiling", () => {
  const directory = mkdtempSync(join(tmpdir(), "atomic-duration-guard-"));
  try {
    writeFileSync(join(directory, "package.json"), JSON.stringify({ scripts: { "test:unit": "bun test --timeout 30000 test/unit" } }));
    writeFileSync(
      join(directory, "suite.test.ts"),
      ['test("heavy but declared", async () => {', "}, 60_000);", 'test("heavy and undeclared", async () => {', "});"].join("\n"),
    );
    const output = [
      "suite.test.ts:",
      "(pass) heavy but declared [25000.00ms]",
      "(pass) heavy and undeclared [25000.00ms]",
      "(pass) comfortable [1000.00ms]",
    ].join("\n");

    const report = evaluateDurations(output, ["bun", "run", "test:unit"], directory);
    assert.equal(report.enabled, true);
    assert.equal(report.defaultTimeoutMs, 30_000);
    assert.deepEqual(report.failures.map((sample) => sample.name), ["heavy and undeclared"]);
    assert.deepEqual(report.warnings.map((sample) => sample.name), ["heavy but declared"]);
    assert.equal(report.samples[0]?.timeoutMs, 30_000);
    assert.equal(report.samples[0]?.explicit, false);
    assert.equal(report.samples[1]?.timeoutMs, 60_000);
    assert.equal(report.samples[1]?.explicit, true);
    assert.equal(report.samples.at(-1)?.name, "comfortable");
    assert.match(renderDurationTable(report), /heavy and undeclared/);

    const undeclared = evaluateDurations(output, ["bun", "suite.test.ts"], directory);
    assert.equal(undeclared.enabled, false);
    assert.deepEqual(undeclared.failures, []);
    assert.deepEqual(undeclared.warnings, []);
    assert.equal(undeclared.samples.length, 3);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("guard thresholds keep the observed Windows tail silent and bound a genuine hang", () => {
  assert.ok(WARN_RATIO < FAIL_RATIO && FAIL_RATIO < 1);
  // Worst recorded Windows sample on the shared default is 10672 ms; the guard
  // must not fire on it, but must fire well before the 30000 ms budget.
  assert.ok(10_672 / 30_000 < WARN_RATIO);
  assert.ok(FAIL_RATIO * 30_000 < 30_000);
});
