import { test } from "bun:test";
import assert from "node:assert/strict";
import { $ } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

test("test workflow runs platform-independent suites once and preserves cross-platform smoke", async () => {
  const workflow = await Bun.file(join(root, ".github/workflows/test.yml")).text();
  for (const step of ["Typecheck", "File length check", "Docs link validation"]) {
    const block = workflow.slice(workflow.indexOf(`- name: ${step}`), workflow.indexOf("- name:", workflow.indexOf(`- name: ${step}`) + 1));
    assert.match(block, /if: runner\.os == 'Linux'/, `${step} must run on only one matrix leg`);
  }
  assert.match(workflow, /ATOMIC_REQUIRE_INSTALLED_NODE_SMOKE: "1"/);
  assert.match(workflow, /--skip-install --skip-package-build --platform/);
  assert.match(workflow, /Smoke test Linux release archive/);
  assert.match(workflow, /Smoke test Windows release archive/);
  assert.match(workflow, /run-flaky-test-suite\.ts --label "unit tests/);
  assert.match(workflow, /name: Deterministic CI and release contracts[\s\S]*run: bun run test:ci-contracts/);
  const deterministicBlock = workflow.slice(workflow.indexOf("name: Deterministic CI and release contracts"), workflow.indexOf("name: Unit tests"));
  assert.doesNotMatch(deterministicBlock, /run-flaky-test-suite/);
  assert.match(workflow, /run-flaky-test-suite\.ts --label "integration tests/);
  assert.match(workflow, /run-flaky-test-suite\.ts --label "coding-agent tests/);
  assert.match(workflow, /name: Upload flaky-test diagnostics[\s\S]*if: always\(\)/);
});

test("publish replaces full-suite reruns with release integrity and preserves release gates", async () => {
  const workflow = await Bun.file(join(root, ".github/workflows/publish.yml")).text();
  assert.match(workflow, /bun run scripts\/verify-release-integrity\.ts --base-ref origin\/main/);
  assert.doesNotMatch(workflow, /name: (Typecheck|Test)\n/);
  assert.match(workflow, /npm publish --provenance/g);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /push:\s*\n\s*tags:/);
  assert.match(workflow, /ref: \$\{\{ needs\.release-integrity\.outputs\.sha \}\}/);
  assert.match(workflow, /needs: release-integrity/);
  assert.match(workflow, /name: Mintlify docs validation/);
  const integrityJob = workflow.slice(workflow.indexOf("release-integrity:"), workflow.indexOf("linux-binary-smoke:"));
  assert.doesNotMatch(integrityJob, /ref: \$\{\{ github\.event\.inputs\.tag/);
  assert.match(integrityJob, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(integrityJob, /WORKFLOW_REF_NAME.*github\.ref_name/);
  assert.match(integrityJob, /DEFAULT_BRANCH.*repository\.default_branch/);
  assert.match(integrityJob, /git ls-remote --exit-code --refs origin/);
  assert.match(workflow, /atomic_natives\.win32-arm64-msvc\.node/);
  assert.match(workflow, /atomic-windows-arm64\.zip/);
  assert.match(workflow, /bun run check:shrinkwrap/);
  assert.match(workflow, /name: Reconfirm release tag is immutable[\s\S]*current_sha[\s\S]*VERIFIED_SHA/);
});

test("release verifier accepts generated release and rejects an extra forged file", async () => {
  const tag = "0.9.7-alpha.1";
  const integrityWorktrees = async () => (await $`git worktree list --porcelain`.cwd(root).text())
    .split("\n")
    .filter((line) => line.startsWith("worktree ") && line.includes("atomic-release-integrity-")).length;
  const worktreesBefore = await integrityWorktrees();
  const valid = await $`bun run scripts/verify-release-integrity.ts --base-ref origin/main --release-commit ${tag}`.cwd(root).nothrow().quiet();
  assert.equal(valid.exitCode, 0, valid.stderr.toString());

  const temp = mkdtempSync(join(tmpdir(), "atomic-forged-release-"));
  const index = join(temp, "index");
  try {
    const tree = (await $`git show -s --format=%T ${tag}`.cwd(root).text()).trim();
    const parent = (await $`git show -s --format=%P ${tag}`.cwd(root).text()).trim();
    await $`git read-tree ${tree}`.cwd(root).env({ ...process.env, GIT_INDEX_FILE: index }).quiet();
    const blob = (await $`printf 'forged\\n' | git hash-object -w --stdin`.cwd(root).text()).trim();
    await $`git update-index --add --cacheinfo 100644,${blob},FORGED_RELEASE_FILE`.cwd(root).env({ ...process.env, GIT_INDEX_FILE: index }).quiet();
    const forgedTree = (await $`git write-tree`.cwd(root).env({ ...process.env, GIT_INDEX_FILE: index }).text()).trim();
    const forged = (await $`printf ${`Release ${tag}\\n`} | git commit-tree ${forgedTree} -p ${parent}`.cwd(root).env({ ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" }).text()).trim();
    const result = await $`bun run scripts/verify-release-integrity.ts --base-ref origin/main --release-commit ${forged}`.cwd(root).nothrow().quiet();
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr.toString(), /does not match deterministic version\/shrinkwrap output/);

    const badSubject = (await $`printf 'Forged subject\\n' | git commit-tree ${tree} -p ${parent}`.cwd(root).env({ ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" }).text()).trim();
    const subjectResult = await $`bun run scripts/verify-release-integrity.ts --base-ref origin/main --release-commit ${badSubject}`.cwd(root).nothrow().quiet();
    assert.notEqual(subjectResult.exitCode, 0);
    assert.match(subjectResult.stderr.toString(), /commit subject must be/);

    const unintegrated = (await $`printf ${`Release ${tag}\\n`} | git commit-tree ${tree} -p ${tag}`.cwd(root).env({ ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" }).text()).trim();
    const ancestryResult = await $`bun run scripts/verify-release-integrity.ts --base-ref origin/main --release-commit ${unintegrated}`.cwd(root).nothrow().quiet();
    assert.notEqual(ancestryResult.exitCode, 0);
    assert.match(ancestryResult.stderr.toString(), /is not integrated into origin\/main/);
    assert.equal(await integrityWorktrees(), worktreesBefore, "failed verification must clean up its temporary worktree registration");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
