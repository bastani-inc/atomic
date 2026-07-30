import { test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalReleaseBaseRef,
  parseReleaseBaseTrailers,
  validateCanonicalReleaseBaseRef,
} from "../../scripts/release-base.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const publishPath = join(root, ".github/workflows/publish.yml");
const testPath = join(root, ".github/workflows/test.yml");
const warmPath = join(root, ".github/workflows/warm-toolchain-cache.yml");

/**
 * File text with platform-neutral newlines.
 *
 * These contracts assert on what the repository stores, which is LF. But
 * `.gitattributes` marks `*.yml` as `text` without `eol=lf`, so the Windows
 * runner checks the workflows out as CRLF, and any pattern here containing a
 * literal `\n` would then pass on Linux and fail on Windows.
 */
async function readText(path: string): Promise<string> {
  return (await Bun.file(path).text()).replaceAll("\r\n", "\n");
}

function jobBlock(workflow: string, name: string, next?: string): string {
  const start = workflow.indexOf(`  ${name}:`);
  assert.notEqual(start, -1, `missing job: ${name}`);
  const end = next ? workflow.indexOf(`  ${next}:`, start + 1) : workflow.length;
  return workflow.slice(start, end);
}

function stepBlock(workflow: string, name: string, next: string): string {
  const start = workflow.indexOf(`- name: ${name}`);
  assert.notEqual(start, -1, `missing step: ${name}`);
  const end = workflow.indexOf(`- name: ${next}`, start + 1);
  assert.notEqual(end, -1, `missing next step: ${next}`);
  return workflow.slice(start, end);
}

/** Split a job block into its individual steps, indentation-agnostically. */
function jobSteps(block: string): string[] {
  const header = /^(\s*)steps:$/mu.exec(block);
  assert.ok(header, "job declares no steps");
  const body = block.slice(header.index + header[0].length);
  const first = /^([ \t]+)- /mu.exec(body);
  assert.ok(first, "job declares no steps");
  return body.split(new RegExp(`^${first[1] as string}- `, "gmu")).slice(1);
}

/** Every job in a workflow, paired with its own block. */
function jobBlocks(workflow: string): [string, string][] {
  const jobs = workflow.slice(workflow.indexOf("\njobs:\n"));
  const names = [...jobs.matchAll(/^  ([a-z][a-z0-9-]*):$/gmu)].map(([, name]) => name as string);
  return names.map((name, index) => [name, jobBlock(jobs, name, names[index + 1])]);
}

test("test workflow preserves its two-platform matrix and deterministic contracts", async () => {
  const workflow = await readText(join(root, ".github/workflows/test.yml"));
  const testJob = jobBlock(workflow, "test");
  assert.match(testJob, /^[ \t]+name: test \(\$\{\{ matrix\.os \}\}, \$\{\{ matrix\.binary_platform \}\}\)$/mu);
  const matrixContexts = [...testJob.matchAll(/^[ \t]+- os: (\S+)\s+binary_platform: (\S+)$/gmu)]
    .map(([, os, platform]) => `test (${os}, ${platform})`);
  assert.deepEqual(matrixContexts, [
    "test (blacksmith-4vcpu-ubuntu-2404, linux-x64)",
    "test (blacksmith-4vcpu-windows-2025, windows-x64)",
  ]);
  assert.match(workflow, /blacksmith-4vcpu-ubuntu-2404/);
  assert.match(workflow, /blacksmith-4vcpu-windows-2025/);
  assert.match(workflow, /blacksmith-4vcpu-ubuntu-2404\s+binary_platform: linux-x64\s+timeout_minutes: 10/);
  assert.match(workflow, /blacksmith-4vcpu-windows-2025\s+binary_platform: windows-x64\s+timeout_minutes: 15/);
  assert.match(workflow, /timeout-minutes: \$\{\{ matrix\.timeout_minutes \}\}/);
  assert.match(workflow, /name: Deterministic CI and release contracts[\s\S]*run: bun run test:ci-contracts/);
  assert.match(workflow, /Smoke test Linux release archive/);
  assert.match(workflow, /Smoke test Windows release archive/);
  assert.match(
    stepBlock(workflow, "coding-agent vitest suite (one bounded flake retry)", "Build native release binary"),
    /ATOMIC_REQUIRE_NATIVE_BINDING_SMOKE: "1"/u,
  );
});

/**
 * The per-test timeout budget lives in package.json and nowhere else.
 *
 * Bun 1.3.14 silently ignores `[test] timeout` in bunfig.toml, and CI reaches
 * every suite through `bun run <script>`, so the scripts are the one choke point
 * where the local and CI budgets cannot drift apart. A single platform-neutral
 * value keeps Windows regressions enforced against the same contract as Linux.
 */
test("every Bun test suite entry point declares one shared per-test timeout", async () => {
  const manifest = (await Bun.file(join(root, "package.json")).json()) as { scripts: Record<string, string> };
  const budgets = new Set<string>();
  for (const script of ["test:unit", "test:integration", "test:ci-contracts"]) {
    const command = manifest.scripts[script];
    assert.ok(command, `missing script: ${script}`);
    const timeout = /--timeout[= ](\d+)/u.exec(command as string);
    assert.ok(timeout, `${script} must pass --timeout (bunfig [test] timeout is ignored by Bun)`);
    const value = Number(timeout[1]);
    assert.ok(value >= 30_000, `${script} timeout ${value} is below the 30000 ms floor`);
    assert.ok(value <= 120_000, `${script} timeout ${value} would outlive the Windows job budget`);
    budgets.add(timeout[1] as string);
  }
  assert.equal(budgets.size, 1, `suite timeouts diverged: ${[...budgets].join(", ")}`);
  assert.doesNotMatch(await readText(join(root, "bunfig.toml")), /^\s*timeout\s*=/mu);
  assert.match(
    await readText(join(root, ".github/workflows/test.yml")),
    /run-flaky-test-suite\.ts/u,
  );
});

test("active CI workflows contain no removed Cursor builtin smoke checks", async () => {
  for (const path of [join(root, ".github/workflows/test.yml"), publishPath]) {
    assert.doesNotMatch(await readText(path), /builtin\/cursor/iu, path);
  }
});

test("binary staging and every release smoke verify the exact builtin directory set", async () => {
  const checker = /scripts\/assert-builtin-set\.ts/u;
  const testWorkflow = await readText(join(root, ".github/workflows/test.yml"));
  const publishWorkflow = await readText(publishPath);
  const buildScript = await readText(join(root, "scripts/build-binaries.sh"));

  assert.match(stepBlock(testWorkflow, "Smoke test Linux release archive", "Smoke test Windows release archive"), checker);
  assert.match(stepBlock(testWorkflow, "Smoke test Windows release archive", "Upload flaky-test diagnostics"), checker);
  assert.equal(testWorkflow.split("scripts/assert-builtin-set.ts").length - 1, 2);
  assert.match(jobBlock(publishWorkflow, "linux-binary-smoke", "windows-binary-smoke"), checker);
  assert.match(jobBlock(publishWorkflow, "windows-binary-smoke", "build"), checker);
  assert.match(jobBlock(publishWorkflow, "build", "stage-github-release"), checker);
  assert.equal(publishWorkflow.split("scripts/assert-builtin-set.ts").length - 1, 3);
  assert.match(buildScript, /assert-builtin-set\.ts "binaries\/\$platform\/builtin"/u);
});

test("publish workflow has direct tag and recovery triggers", async () => {
  const workflow = await readText(publishPath);
  assert.match(workflow, /push:\s*\n\s*tags:/);
  assert.match(workflow, /"\[0-9\]\*\.\[0-9\]\*\.\[0-9\]\*"/);
  assert.match(workflow, /workflow_dispatch:\s*\n\s*inputs:\s*\n\s*tag:[\s\S]*required: true[\s\S]*source_ref:[\s\S]*required: false/);
  assert.match(workflow, /SOURCE_REF: \$\{\{ github\.event\.inputs\.source_ref \|\| github\.event\.inputs\.tag \|\| github\.ref_name \}\}/);
  assert.doesNotMatch(workflow, /workflow_run:|create:|repository_dispatch:/);
});

test("publish workflow uses one lightweight integrity gate", async () => {
  const workflow = await readText(publishPath);
  const integrity = jobBlock(workflow, "integrity", "native-artifacts");
  assert.equal([...workflow.matchAll(/^  integrity:$/gmu)].length, 1);
  assert.match(integrity, /ref: \$\{\{ env\.RELEASE_TAG \}\}/);
  assert.match(integrity, /packages\/coding-agent\/package\.json/);
  assert.match(integrity, /Package version \$version does not match tag \$RELEASE_TAG/);
  assert.match(integrity, /subject.*git show -s --format=%s/);
  assert.match(integrity, /Release \$RELEASE_TAG/);
  assert.doesNotMatch(integrity, /Release-base-|merge-base|workflow_ref|workflow_sha|git archive|bump-version|generate-coding-agent-shrinkwrap/iu);
});

test("publish graph stages a draft before npm and undrafts last", async () => {
  const workflow = await readText(publishPath);
  for (const job of ["integrity", "native-artifacts", "linux-binary-smoke", "windows-binary-smoke", "build", "stage-github-release", "publish-npm", "publish-github-release", "cleanup-draft-github-release"]) {
    assert.match(workflow, new RegExp(`^  ${job}:$`, "mu"));
  }
  assert.match(jobBlock(workflow, "build", "stage-github-release"), /needs: \[integrity, native-artifacts, linux-binary-smoke, windows-binary-smoke\]/);
  const stage = jobBlock(workflow, "stage-github-release", "publish-npm");
  assert.match(stage, /needs: \[integrity, build\]/);
  assert.match(stage, /already published.*Refusing to mutate[\s\S]*--verify-tag --draft/s);
  assert.match(jobBlock(workflow, "publish-npm", "publish-github-release"), /needs: \[integrity, stage-github-release\]/);
  assert.match(jobBlock(workflow, "publish-github-release", "cleanup-draft-github-release"), /needs: \[stage-github-release, publish-npm\][\s\S]*--draft=false/);
  assert.match(jobBlock(workflow, "cleanup-draft-github-release"), /always\(\).*needs\.stage-github-release\.result != 'skipped'.*needs\.publish-npm\.result != 'success'/);
});

test("publish permissions, timeouts, runners, and OIDC are least privilege", async () => {
  const workflow = await readText(publishPath);
  assert.match(workflow.slice(0, workflow.indexOf("jobs:")), /permissions:\s*\n\s*contents: read/);
  const npm = jobBlock(workflow, "publish-npm", "publish-github-release");
  assert.match(npm, /environment: npm-publish/);
  assert.match(npm, /permissions:\s*\n\s*contents: read\s*\n\s*id-token: write/);
  assert.doesNotMatch(npm, /contents: write/);
  assert.match(npm, /npm publish .*--provenance.*--tag "\$NPM_TAG"/);
  assert.match(npm, /npm view .*@\$VERSION.*already exists; skipping/s);
  for (const writeJob of [jobBlock(workflow, "stage-github-release", "publish-npm"), jobBlock(workflow, "publish-github-release", "cleanup-draft-github-release"), jobBlock(workflow, "cleanup-draft-github-release")]) {
    assert.match(writeJob, /contents: write/);
    assert.match(writeJob, /GH_REPO: \$\{\{ github\.repository \}\}/);
    assert.doesNotMatch(writeJob, /id-token: write|npm publish/);
  }
  assert.equal([...workflow.matchAll(/^    timeout-minutes:/gmu)].length, 9);
  assert.match(workflow, /blacksmith-4vcpu-ubuntu-2404-arm/);
  assert.match(workflow, /macos-26-intel/);
  assert.match(workflow, /blacksmith-6vcpu-macos-26/);
  assert.match(workflow, /blacksmith-4vcpu-windows-2025/);
});

test("native release matrix pins all shipped targets and the Linux glibc floor", async () => {
  const workflow = await readText(publishPath);
  const native = jobBlock(workflow, "native-artifacts", "linux-binary-smoke");
  for (const target of [
    "x86_64-unknown-linux-gnu",
    "aarch64-unknown-linux-gnu",
    "x86_64-apple-darwin",
    "aarch64-apple-darwin",
    "x86_64-pc-windows-msvc",
    "aarch64-pc-windows-msvc",
  ]) assert.match(native, new RegExp(target));
  assert.match(workflow.slice(0, workflow.indexOf("jobs:")), /GLIBC_FLOOR: "2\.17"/);
  assert.match(native, /build_target="\$\{BARE_TARGET\}\.\$\{GLIBC_FLOOR\}"/);
  assert.match(native, /toolchain: 1\.97\.0/);
  assert.match(workflow.slice(0, workflow.indexOf("jobs:")), /RUSTUP_TOOLCHAIN: "1\.97\.0"/);
  assert.match(native, /NATIVE_TARGET: \$\{\{ matrix\.platform == 'darwin' && matrix\.target \|\| '' \}\}/);
  assert.match(native, /CROSS_TARGET: \$\{\{ matrix\.platform != 'darwin'/);
  assert.match(native, /cargo-zigbuild/);
  assert.match(native, /RUSTFLAGS=-C target-cpu=x86-64-v2/);
  assert.match(native, /fail-fast: false/);
  assert.match(native, /name: atomic-natives-\$\{\{ matrix\.platform \}\}-\$\{\{ matrix\.arch \}\}/);
  assert.match(native, /macos-26-intel/);
  assert.match(native, /blacksmith-6vcpu-macos-26/);
  assert.doesNotMatch(native, /run-id:|github-token:|artifact_lookup/iu);
  // The job may cache third-party toolchain acquisitions and nothing else.
  // Caching Cargo build output would make a provenance-signed artifact depend
  // on restored build state.
  assert.doesNotMatch(native, /rust-cache|sccache|CARGO_TARGET_DIR/iu);
  assert.deepEqual(
    [...native.matchAll(/^\s+path: (\S+)$/gmu)].map(([, value]) => value),
    ["~/.cache/cargo-xwin", "packages/natives/native/*.node"],
  );
});

test("release build retains Atomic native, smoke, shrinkwrap, metadata, and asset contracts", async () => {
  const workflow = await readText(publishPath);
  assert.match(workflow, /"win32-arm64-msvc"/);
  assert.match(workflow, /atomic-windows-arm64\.zip/);
  assert.match(workflow, /bun run check:shrinkwrap/);
  assert.match(workflow, /Build Linux x64 archive[\s\S]*--platform linux-x64/);
  assert.match(workflow, /Build Windows x64 archive[\s\S]*--platform windows-x64/);
  assert.match(workflow, /Failed to load extension/);
  assert.match(workflow, /native optionalDependencies must be the six exact-version platform packages/);
  assert.match(workflow, /test .* = 8/);
  assert.doesNotMatch(workflow, /Release-base-ref|Release-base-sha|RELEASE_BASE_REFS|deterministic release tree|create-event binding/iu);
});

test("obsolete release workflow files and publisher-only verifiers are absent", () => {
  for (const path of [
    ".github/workflows/publish" + "-tag-created.yml",
    ".github/workflows/publish" + "-release.yml",
    "scripts/verify" + "-publish-context.ts",
    "scripts/verify" + "-release-integrity.ts",
  ]) assert.equal(existsSync(join(root, path)), false, path);
});


test("developer release setup documents only the direct publish workflow", async () => {
  const setup = await readText(join(root, "DEV_SETUP.md"));
  assert.match(setup, /tag push starts `\.github\/workflows\/publish\.yml` directly/u);
  assert.match(setup, /trusted publishers with workflow filename `publish\.yml` and environment `npm-publish`/u);
  for (const forbidden of [
    "publish" + "-tag-created.yml",
    "publish" + "-release.yml",
    "RELEASE" + "_BASE_REFS",
    "NPM" + "_TOKEN",
    "NODE" + "_AUTH_TOKEN",
  ]) assert.equal(setup.includes(forbidden), false, forbidden);
});
test("release-base metadata remains available to the versionless cut flow", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  assert.equal(canonicalReleaseBaseRef("main"), "refs/heads/main");
  assert.equal(validateCanonicalReleaseBaseRef("refs/heads/release/workstream-1"), "refs/heads/release/workstream-1");
  for (const newline of ["\n", "\r\n"]) {
    const message = `Release 1.2.3${newline}${newline}Release-base-ref: refs/heads/main${newline}Release-base-sha: ${sha}${newline}`;
    assert.deepEqual(parseReleaseBaseTrailers(message), { baseRef: "refs/heads/main", baseSha: sha });
  }
});

test("cut-release still creates the detached version-stamped tag", async () => {
  const script = await readText(join(root, "scripts/cut-release.ts"));
  assert.match(script, /canonicalReleaseBaseRef\(baseBranch\)/);
  assert.match(script, /Release-base-ref: \$\{baseRef\}\\nRelease-base-sha: \$\{baseSha\}/);
  assert.match(script, /git -C \$\{ROOT\} push origin \$\{version\}/);
  assert.doesNotMatch(script, /Bun\.sleep|setTimeout/);
});

/**
 * Run 30517879019 (`Publish 0.9.11-alpha.8`) spent 13m27s inside one stalled
 * Zig mirror, was cancelled by the blanket 15-minute job cap 8s after its
 * artifact upload had already succeeded, and the cancelled `needs` dependency
 * then skipped the payload build, the draft, npm, and the release. A job cap
 * cannot detect that; only a bound on the acquisition step itself can.
 */
test("native-artifacts bounds every dependency acquisition step", async () => {
  const native = jobBlock(await readText(publishPath), "native-artifacts", "linux-binary-smoke");
  const steps = jobSteps(native);
  const budget = (needle: string): number => {
    const matches = steps.filter((step) => step.includes(needle));
    assert.equal(matches.length, 1, `expected exactly one step containing: ${needle}`);
    const bound = /^\s*timeout-minutes: (\d+)$/mu.exec(matches[0] as string);
    assert.ok(bound, `unbounded acquisition step: ${needle}`);
    return Number(bound[1]);
  };
  assert.equal(budget("uses: dtolnay/rust-toolchain@"), 4);
  assert.equal(budget("tool: cargo-zigbuild@"), 3);
  assert.equal(budget("tool: cargo-xwin@"), 3);
  assert.equal(budget("apt-get install"), 5);
  assert.equal(budget("cargo-xwin xwin cache xwin"), 8);

  const zigSteps = steps.filter((step) => step.includes("mlugg/setup-zig@"));
  assert.equal(zigSteps.length, 2, "the Zig acquisition must keep exactly one bounded retry");
  const [zig, retry] = zigSteps as [string, string];
  assert.match(zig, /id: zig\n\s+if: matrix\.platform == 'linux'\n\s+continue-on-error: true\n\s+timeout-minutes: 2\n/u);
  assert.match(retry, /if: matrix\.platform == 'linux' && steps\.zig\.outcome == 'failure'\n\s+timeout-minutes: 2\n/u);
  for (const step of zigSteps) {
    // The tool cache is copied into an ephemeral VM, and the global Zig cache
    // has never been read back on a release tag. Disabling both also keeps a
    // killed attempt's post step inert so the retry adds no failure mode.
    assert.match(step, /use-tool-cache: false/u);
    assert.match(step, /use-cache: false/u);
  }

  for (const step of steps) {
    if (!/uses: (dtolnay|mlugg|taiki-e)\//u.test(step)) continue;
    assert.match(step, /timeout-minutes: \d+/u, `unbounded acquisition step:\n${step}`);
  }
});

/**
 * `useblacksmith/checkout` consumes a Blacksmith sticky disk. Sticky disks are
 * ext4 block devices, so they exist only on Blacksmith Linux runners; the
 * Windows leg warns and falls back, and the macOS ARM leg blocked 78s on a
 * gRPC connect timeout in 8 of 8 releases before falling back.
 */
test("sticky-disk checkout stays on Blacksmith Linux runners", async () => {
  for (const path of [publishPath, testPath, warmPath]) {
    const workflow = await readText(path);
    for (const [name, block] of jobBlocks(workflow)) {
      const runsOn = /^\s+runs-on: (\S+)$/mu.exec(block)?.[1] ?? "";
      for (const step of jobSteps(block)) {
        if (!step.includes("useblacksmith/")) continue;
        const guarded = /if: runner\.os == 'Linux'/u.test(step);
        assert.ok(
          guarded || /^blacksmith-\dvcpu-ubuntu/u.test(runsOn),
          `${path}: job ${name} requests a sticky disk on ${runsOn || "a matrix runner"}`,
        );
      }
    }
  }
  const publish = await readText(publishPath);
  assert.doesNotMatch(jobBlock(publish, "windows-binary-smoke", "build"), /useblacksmith/u);
  for (const block of [
    jobBlock(publish, "native-artifacts", "linux-binary-smoke"),
    jobBlock(await readText(testPath), "test"),
  ]) {
    assert.match(block, /uses: useblacksmith\/checkout@[0-9a-f]{40}[^\n]*\n\s+if: runner\.os == 'Linux'/u);
    assert.match(block, /uses: actions\/checkout@[0-9a-f]{40}[^\n]*\n\s+if: runner\.os != 'Linux'/u);
  }
});

test("every third-party action is pinned to a full commit SHA with a version comment", async () => {
  for (const path of [publishPath, testPath, warmPath]) {
    const workflow = await readText(path);
    const uses = [...workflow.matchAll(/^\s*(?:- )?uses: (\S+)(.*)$/gmu)];
    assert.ok(uses.length > 0, `${path} declares no actions`);
    for (const [, action, trailer] of uses) {
      assert.match(action as string, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/u, `${path}: ${action} is not SHA-pinned`);
      assert.match(trailer as string, /^ # v?[\w.-]+$/u, `${path}: ${action} needs a version comment`);
    }
  }
});

test("the shipped build toolchain and Bun do not float", async () => {
  const publish = await readText(publishPath);
  const warm = await readText(warmPath);
  for (const workflow of [publish, warm]) {
    for (const [, tool] of workflow.matchAll(/^\s+tool: (\S+)$/gmu)) {
      assert.match(tool as string, /^cargo-(zigbuild|xwin)@\d+\.\d+\.\d+$/u, `floating build tool: ${tool}`);
    }
  }
  const bunVersions = new Set(
    [...`${publish}\n${await readText(testPath)}`.matchAll(/bun-version: (\S+)/gu)].map(([, value]) => value as string),
  );
  assert.deepEqual([...bunVersions], ["1.3.14"], "test.yml and publish.yml must exercise one pinned Bun");
});

test("each native leg declares its own measured job and compile budget", async () => {
  const native = jobBlock(await readText(publishPath), "native-artifacts", "linux-binary-smoke");
  assert.match(native, /^    timeout-minutes: \$\{\{ matrix\.timeout_minutes \}\}$/mu);
  assert.match(native, /- name: Build native binding\n\s+timeout-minutes: \$\{\{ matrix\.build_timeout_minutes \}\}/u);
  const legs = [...native.matchAll(/platform: (\w+), arch: (\w+),[^}]*timeout_minutes: (\d+), build_timeout_minutes: (\d+)/gu)]
    .map(([, platform, arch, job, build]) => `${platform} ${arch} ${job}/${build}`);
  assert.deepEqual(legs, [
    "linux x64 7/5",
    "linux arm64 8/5",
    "darwin x64 9/8",
    "darwin arm64 5/5",
    "win32 x64 10/5",
    "win32 arm64 10/5",
  ]);
  // The single blanket cap that covered six legs spanning 55s to 443s of real
  // work must not come back.
  assert.doesNotMatch(native, /timeout-minutes: 15/u);
});

test("the toolchain warm workflow stays read-only, gated, and key-compatible", async () => {
  const warm = await readText(warmPath);
  const publish = await readText(publishPath);
  assert.match(warm, /permissions:\s*\n\s*contents: read/u);
  assert.doesNotMatch(warm, /contents: write|id-token: write|npm publish|gh release|upload-artifact/u);
  // Gated: whether a refs/tags/* run reads a refs/heads/main cache entry on
  // Blacksmith's colocated cache is documented but unverified here, so the
  // daily schedule lands only after the docs/ci.md experiment observes a hit.
  assert.match(warm, /^on:\n  workflow_dispatch:\n/mu);
  assert.doesNotMatch(warm, /\n\s+schedule:/u);
  const key = /key: (xwin-v\d+-\$\{\{ matrix\.arch \}\}-\d+)/u;
  assert.equal(key.exec(warm)?.[1], key.exec(publish)?.[1], "warm and release CRT cache keys must match");
  const zigVersion = /uses: mlugg\/setup-zig@[^\n]*\n\s+with:\n\s+version: (\S+)/u;
  assert.equal(zigVersion.exec(warm)?.[1], zigVersion.exec(publish)?.[1], "warm and release Zig versions must match");
  assert.match(await readText(join(root, "docs/ci.md")), /xwin-v1/u);
});

type MatrixEntry = Record<string, string | number | boolean>;

interface WorkflowMatrix {
  include?: MatrixEntry[];
  [key: string]: string[] | MatrixEntry[] | undefined;
}

interface Workflow {
  jobs?: Record<string, { "runs-on"?: string | string[]; strategy?: { matrix?: WorkflowMatrix } }>;
}

/**
 * Every runner a job can select.
 *
 * `runs-on: ${{ matrix.<key> }}` is resolved through the job's own matrix. Reading
 * the literal alone would let `matrix: { os: [ubuntu-24.04] }` pick an unapproved
 * GitHub-hosted runner that no contract here ever sees.
 */
function jobRunners(label: string, job: NonNullable<Workflow["jobs"]>[string]): string[] {
  const runsOn = job["runs-on"] ?? [];
  return (typeof runsOn === "string" ? [runsOn] : runsOn).flatMap((value) => {
    const key = /^\$\{\{\s*matrix\.([\w-]+)\s*\}\}$/u.exec(value)?.[1];
    if (key === undefined) {
      // An expression this cannot resolve must not pass as a literal runner name.
      assert.doesNotMatch(value, /\$\{\{/u, `${label}: unresolvable runs-on ${value}`);
      return [value];
    }
    const matrix = job.strategy?.matrix ?? {};
    const values = [...(matrix[key] ?? []), ...(matrix.include ?? []).map((entry) => entry[key])]
      .filter((entry): entry is string => typeof entry === "string");
    assert.ok(values.length > 0, `${label}: matrix.${key} names no runner`);
    return values;
  });
}

test("Blacksmith runners are used everywhere they are supported", async () => {
  const publish = await readText(publishPath);
  // Enumerate the directory rather than a fixed list: a workflow added later
  // must not be able to introduce an unapproved GitHub-hosted runner unnoticed.
  const workflowDir = join(root, ".github/workflows");
  const workflowFiles = (await readdir(workflowDir))
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort();
  assert.ok(workflowFiles.length >= 3, "expected the workflows directory to be enumerable");
  const hosted: string[] = [];
  for (const file of workflowFiles) {
    const workflow = Bun.YAML.parse(await readText(join(workflowDir, file))) as Workflow;
    for (const [name, job] of Object.entries(workflow.jobs ?? {})) {
      hosted.push(...jobRunners(`${file} ${name}`, job).filter((runner) => !runner.startsWith("blacksmith-")));
    }
  }
  // Only two jobs may stay GitHub-hosted, and each for a reason that a future
  // "move everything to Blacksmith" pass must not quietly undo:
  //   macos-26-intel - Blacksmith macOS is Apple Silicon only, so this is the
  //     only runner that can produce the darwin x64 native binding.
  //   ubuntu-latest  - npm trusted publishing rejects self-hosted runners, and
  //     Blacksmith registers through GitHub's org-level registration API.
  assert.deepEqual(hosted.sort(), ["macos-26-intel", "ubuntu-latest"]);
  assert.match(publish, /# Blacksmith macOS is Apple Silicon only[^\n]*\n\s+- \{ runner: macos-26-intel/u);
  assert.match(publish, /npm trusted publishing rejects self-hosted runners[\s\S]{0,160}?runs-on: ubuntu-latest/u);
  // ubuntu-latest is only ever acceptable on the OIDC publish job.
  assert.equal(jobBlock(publish, "publish-npm", "publish-github-release").includes("runs-on: ubuntu-latest"), true);
});
