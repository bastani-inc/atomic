import { test } from "bun:test";
import assert from "node:assert/strict";
import { $ } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalReleaseBaseRef,
  parseReleaseBaseTrailers,
  validateCanonicalReleaseBaseRef,
} from "../../scripts/release-base.js";

const root = fileURLToPath(new URL("../..", import.meta.url));

test("test workflow runs platform-independent suites once and preserves cross-platform smoke", async () => {
  const workflow = await Bun.file(join(root, ".github/workflows/test.yml")).text();
  assert.match(workflow, /pull_request:\s*\r?\n\s*jobs:/);
  assert.doesNotMatch(workflow, /pull_request:\s*\r?\n\s*branches:/);
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

test("release-base metadata preserves exact canonical refs and raw LF/CRLF trailers", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  assert.equal(canonicalReleaseBaseRef("main"), "refs/heads/main");
  assert.equal(canonicalReleaseBaseRef("release/workstream-1"), "refs/heads/release/workstream-1");
  assert.equal(validateCanonicalReleaseBaseRef("refs/heads/release/workstream-1"), "refs/heads/release/workstream-1");
  for (const newline of ["\n", "\r\n"]) {
    const message = `Release 1.2.3${newline}${newline}Release-base-ref: refs/heads/release/workstream-1${newline}Release-base-sha: ${sha}${newline}`;
    assert.deepEqual(parseReleaseBaseTrailers(message), { baseRef: "refs/heads/release/workstream-1", baseSha: sha });
  }
});

test("release-base metadata rejects aliases, injection, duplicates, and normalization", () => {
  for (const ref of ["origin/main", "refs/heads/main", " main", "main ", "main\tother", "main:evil", "main^{}", "../main", "main.lock", "main\nother"]) {
    assert.throws(() => canonicalReleaseBaseRef(ref), /canonical remote branch name/u);
  }
  for (const ref of ["main", "refs/tags/main", "refs/heads/../main", "refs/heads/main:evil", "refs/heads/main.lock"]) {
    assert.throws(() => validateCanonicalReleaseBaseRef(ref), /canonical refs\/heads/u);
  }
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const valid = `Release 1.2.3\n\nRelease-base-ref: refs/heads/main\nRelease-base-sha: ${sha}\n`;
  for (const message of [
    "Release 1.2.3\n",
    `${valid}Release-base-ref: refs/heads/main\n`,
    valid.replace(sha, "ABCDEF"),
    valid.replace("refs/heads/main", " refs/heads/main"),
    valid.replace(`Release-base-sha: ${sha}`, `Release-base-sha:${sha}`),
    valid.replace(sha, `${sha} `),
  ]) {
    assert.throws(() => parseReleaseBaseTrailers(message), /release base trailer/iu);
  }
});

test("publish uses the default-branch create event with least-privilege jobs", async () => {
  const workflow = await Bun.file(join(root, ".github/workflows/publish.yml")).text();
  assert.match(workflow, /on:[ \t]*\r?\n(?:[ \t]*#[^\r\n]*\r?\n)*[ \t]*create:/);
  assert.doesNotMatch(workflow, /workflow_dispatch:|workflow_run:|push:\s*\r?\n\s*tags:/);
  assert.match(workflow, /permissions:\s*\r?\n\s*contents: read/);
  assert.doesNotMatch(workflow.slice(0, workflow.indexOf("jobs:")), /id-token: write|contents: write/);
  assert.doesNotMatch(workflow, /gh workflow run|--paginate|--watch|sleep [0-9]/);
  assert.match(workflow, /bun run scripts\/verify-release-integrity\.ts[\s\\\r\n]*--base-ref "\$fixed_base_ref"/);
  assert.doesNotMatch(workflow, /name: (Typecheck|Test)\r?\n/);
  assert.match(workflow, /npm publish --provenance/g);
  assert.match(workflow, /ref: \$\{\{ needs\.release-integrity\.outputs\.sha \}\}/);
  assert.match(workflow, /needs: release-integrity/);
  assert.match(workflow, /name: Mintlify docs validation/);
  const integrityJob = workflow.slice(workflow.indexOf("release-integrity:"), workflow.indexOf("linux-binary-smoke:"));
  assert.match(integrityJob, /if: github\.ref_type == 'tag'/);
  assert.match(integrityJob, /RELEASE_TAG.*github\.ref_name/);
  assert.match(integrityJob, /TRIGGER_SHA.*github\.sha/);
  assert.match(integrityJob, /WORKFLOW_REF.*github\.workflow_ref/);
  assert.match(integrityJob, /ref: \$\{\{ github\.workflow_sha \}\}/);
  assert.match(integrityJob, /expected_workflow_ref=.*refs\/heads/);
  assert.match(integrityJob, /release_sha.*TRIGGER_SHA/);
  assert.match(integrityJob, /git ls-remote --exit-code --refs origin/);
  assert.match(integrityJob, /ALLOWED_RELEASE_BASE_REFS.*vars\.RELEASE_BASE_REFS/);
  assert.match(integrityJob, /release_base_ref=.*Release-base-ref/);
  assert.match(integrityJob, /release_base_sha=.*Release-base-sha/);
  assert.match(integrityJob, /release_base_ref.*refs\/heads/);
  assert.match(integrityJob, /refs\/heads\/main/);
  assert.match(integrityJob, /Release base ref is not allowlisted/);
  assert.match(integrityJob, /fixed_base_ref=refs\/remotes\/atomic-publisher\/release-base/);
  assert.match(integrityJob, /git fetch --no-tags origin "\$\{release_base_ref\}:\$\{fixed_base_ref\}"/);
  assert.match(integrityJob, /release_base_sha.*release_parent/);
  assert.match(integrityJob, /merge-base --is-ancestor "\$release_base_sha" "\$fetched_base_sha"/);
  assert.match(integrityJob, /--expected-base-ref "\$release_base_ref"/);
  assert.match(integrityJob, /--expected-base-sha "\$release_base_sha"/);
  const publishJob = workflow.slice(workflow.indexOf("    publish:"));
  assert.match(publishJob, /permissions:\s*\r?\n\s*contents: write\s*\r?\n\s*id-token: write/);
  assert.match(workflow, /atomic_natives\.win32-arm64-msvc\.node/);
  assert.match(workflow, /atomic-windows-arm64\.zip/);
  assert.match(workflow, /bun run check:shrinkwrap/);
  assert.match(workflow, /name: Reconfirm release tag is immutable[\s\S]*current_sha[\s\S]*VERIFIED_SHA/);
});

test("publish-release preserves the selectable base_ref input", async () => {
  const workflow = await Bun.file(join(root, ".atomic/workflows/publish-release.ts")).text();
  assert.match(workflow, /base_ref: Type\.String\(\{[\s\S]*?default: "main"/);
  assert.match(workflow, /const requestedBaseRef = ctx\.inputs\.base_ref\.length === 0 \? "main" : ctx\.inputs\.base_ref/);
  assert.match(workflow, /releaseBaseRef = canonicalReleaseBaseRef\(requestedBaseRef\)/);
  assert.match(workflow, /cut-release\.ts \$\{release\.version\} --base \$\{baseRef\}/);
});

test("release-base workflow contracts are LF and CRLF safe", async () => {
  const lf = (await Bun.file(join(root, ".github/workflows/publish.yml")).text()).replace(/\r\n/gu, "\n");
  for (const workflow of [lf, lf.replace(/\n/gu, "\r\n")]) {
    assert.match(workflow, /release_base_ref=.*Release-base-ref[^\r\n]*\r?\n/);
    assert.match(workflow, /release_base_sha=.*Release-base-sha[^\r\n]*\r?\n/);
    assert.match(workflow, /fixed_base_ref=refs\/remotes\/atomic-publisher\/release-base\r?\n/);
    assert.match(workflow, /--expected-base-ref "\$release_base_ref" \\\r?\n/);
  }
});

test("cut-release records canonical immutable release-base trailers without waiting", async () => {
  const script = await Bun.file(join(root, "scripts/cut-release.ts")).text();
  assert.match(script, /canonicalReleaseBaseRef\(baseBranch\)/);
  assert.match(script, /ls-remote --exit-code --refs origin \$\{baseRef\}/);
  assert.match(script, /--base requires a canonical remote branch name/);
  assert.match(script, /Release-base-ref: \$\{baseRef\}\\nRelease-base-sha: \$\{baseSha\}/);
  assert.doesNotMatch(script, /Bun\.sleep|setTimeout|--no-gpg-sign/);
  assert.match(script, /commit --no-verify/);
});

// This process-heavy contract invokes the verifier through temporary Git
// worktrees; native Windows Git can exceed Bun's 5s default test timeout.
test("release verifier supports legacy local checks and publisher-bound workstreams", async () => {
  const tag = "0.9.7-alpha.1";
  const integrityWorktrees = async () => (await $`git worktree list --porcelain`.cwd(root).text())
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("worktree ") && line.includes("atomic-release-integrity-")).length;
  const worktreesBefore = await integrityWorktrees();
  const legacy = await $`bun run scripts/verify-release-integrity.ts --base-ref origin/main --release-commit ${tag}`.cwd(root).nothrow().quiet();
  assert.equal(legacy.exitCode, 0, legacy.stderr.toString());

  const temp = mkdtempSync(join(tmpdir(), "atomic-forged-release-"));
  const index = join(temp, "index");
  try {
    const tree = (await $`git show -s --format=%T ${tag}`.cwd(root).text()).trim();
    const parent = (await $`git show -s --format=%P ${tag}`.cwd(root).text()).trim();
    const trailerMessage = `Release ${tag}\n\nRelease-base-ref: refs/heads/main\nRelease-base-sha: ${parent}\n`;
    const withTrailers = (await $`printf ${trailerMessage} | git commit-tree ${tree} -p ${parent}`.cwd(root).env({ ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" }).text()).trim();
    const valid = await $`bun run scripts/verify-release-integrity.ts --base-ref origin/main --release-commit ${withTrailers} --expected-base-ref refs/heads/main --expected-base-sha ${parent}`.cwd(root).nothrow().quiet();
    assert.equal(valid.exitCode, 0, valid.stderr.toString());

    const workstreamMessage = trailerMessage.replace("refs/heads/main", "refs/heads/release/workstream-a");
    const workstream = (await $`printf ${workstreamMessage} | git commit-tree ${tree} -p ${parent}`.cwd(root).env({ ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" }).text()).trim();
    const workstreamResult = await $`bun run scripts/verify-release-integrity.ts --base-ref origin/main --release-commit ${workstream} --expected-base-ref refs/heads/release/workstream-a --expected-base-sha ${parent}`.cwd(root).nothrow().quiet();
    assert.equal(workstreamResult.exitCode, 0, workstreamResult.stderr.toString());

    const mismatch = await $`bun run scripts/verify-release-integrity.ts --base-ref origin/main --release-commit ${withTrailers} --expected-base-ref refs/heads/workstream --expected-base-sha ${parent}`.cwd(root).nothrow().quiet();
    assert.notEqual(mismatch.exitCode, 0);
    assert.match(mismatch.stderr.toString(), /does not match expected refs\/heads\/workstream/);

    await $`git read-tree ${tree}`.cwd(root).env({ ...process.env, GIT_INDEX_FILE: index }).quiet();
    const blob = (await $`printf 'forged\\n' | git hash-object -w --stdin`.cwd(root).text()).trim();
    await $`git update-index --add --cacheinfo 100644,${blob},FORGED_RELEASE_FILE`.cwd(root).env({ ...process.env, GIT_INDEX_FILE: index }).quiet();
    const forgedTree = (await $`git write-tree`.cwd(root).env({ ...process.env, GIT_INDEX_FILE: index }).text()).trim();
    const forged = (await $`printf ${trailerMessage} | git commit-tree ${forgedTree} -p ${parent}`.cwd(root).env({ ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" }).text()).trim();
    const forgedResult = await $`bun run scripts/verify-release-integrity.ts --base-ref origin/main --release-commit ${forged} --expected-base-ref refs/heads/main --expected-base-sha ${parent}`.cwd(root).nothrow().quiet();
    assert.notEqual(forgedResult.exitCode, 0);
    assert.match(forgedResult.stderr.toString(), /does not match deterministic version\/shrinkwrap output/);
    assert.equal(await integrityWorktrees(), worktreesBefore, "failed verification must clean up its temporary worktree registration");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}, 30_000);
