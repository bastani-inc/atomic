import { test } from "bun:test";
import assert from "node:assert/strict";
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

test("tag creation listener keeps a minimal checked-in shape and is not framed as a security boundary", async () => {
  const signal = await Bun.file(join(root, ".github/workflows/publish-tag-created.yml")).text();
  const publish = await Bun.file(join(root, ".github/workflows/publish.yml")).text();

  // Strip comment lines so explanatory prose (which references checkout / the
  // npm-publish environment) cannot mask a real construct, then assert the
  // executable body performs no checkout, publish, or privileged action.
  const signalBody = signal.split("\n").filter((line) => !/^\s*#/u.test(line)).join("\n");
  assert.match(signalBody, /on:\n\s+create:/u);
  assert.match(signalBody, /permissions: \{\}/u);
  assert.match(signalBody, /if \[\[ "\$REF_TYPE" != "tag" \]\]; then[\s\S]*exit 1/u);
  assert.doesNotMatch(signalBody, /uses:\s*\S*checkout|id-token|npm publish|action-gh-release/u);
  assert.match(signalBody, /WORKFLOW_REF: \$\{\{ github\.workflow_ref \}\}/u);
  assert.doesNotMatch(signalBody, /refs\/heads\/main/u);

  assert.match(publish, /workflow_run:\n\s+workflows: \["Publish tag created"\]\n\s+types: \[completed\]/u);
  assert.doesNotMatch(publish, /\n\s+create:/u);
  assert.match(publish, /ref: \$\{\{ github\.workflow_sha \}\}/u);
  assert.match(publish, /RELEASE_TAG: \$\{\{ github\.event\.workflow_run\.head_branch \}\}/u);
  assert.match(publish, /TRIGGER_SHA: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/u);
  assert.match(publish, /bun scripts\/verify-publish-context\.ts/u);
  assert.match(publish, /PROTECTED_DEFAULT_REF: refs\/remotes\/atomic-publisher\/protected-default/u);
  assert.match(publish, /environment: npm-publish/u);

  // SEC-001: the listener's minimal shape is preserved, but comments/docs must
  // state it is untrusted tag-sourced YAML and NOT an enforceable boundary.
  assert.match(signal, /NOT an enforceable security boundary/u);
  assert.match(signal, /untrusted/u);
  assert.doesNotMatch(signal, /deliberately unprivileged because/u);
  assert.match(publish, /untrusted signal only/u);
});

test("protected publisher retains release and OIDC integrity gates", async () => {
  const publish = await Bun.file(join(root, ".github/workflows/publish.yml")).text();
  for (const invariant of [
    '[[ "$release_sha" == "$TRIGGER_SHA" ]]',
    "Release-base-ref",
    "Release-base-sha",
    'git merge-base --is-ancestor "$release_base_sha" "$fetched_base_sha"',
    "scripts/verify-release-integrity.ts",
    "persist-credentials: false",
    "id-token: write",
    "npm publish --provenance",
    "Reconfirm release tag is immutable",
  ]) {
    assert.ok(publish.includes(invariant), `missing release invariant: ${invariant}`);
  }
});

test("recovery guidance rejects recreating the unpublished tag at its old commit", async () => {
  const docs = await Bun.file(join(root, "docs/ci.md")).text();
  assert.match(docs, /preferred recovery[\s\S]*0\.9\.10-alpha\.2[\s\S]*post-merge protected `main`/u);
  assert.match(
    docs,
    /Recreating `0\.9\.10-alpha\.1` at its existing commit `88c11adcdddcf5245b7b04dd3d2912c7531906fe` is insufficient/u,
  );
  assert.match(docs, /new deterministic `Release 0\.9\.10-alpha\.1` commit whose parent is post-merge protected `main`/u);
});

test("SEC-001: docs frame the protected workflow_run publisher as the security boundary, not the listener", async () => {
  const ci = await Bun.file(join(root, "docs/ci.md")).text();
  const dev = await Bun.file(join(root, "DEV_SETUP.md")).text();
  const agents = await Bun.file(join(root, "AGENTS.md")).text();

  assert.match(ci, /is untrusted and is not a security boundary/u);
  assert.match(ci, /The security boundary is this protected `workflow_run` publisher/u);
  assert.doesNotMatch(ci, /intentionally unprivileged `publish-tag-created\.yml` listener/u);
  assert.match(dev, /that listener is untrusted and not a security boundary/u);
  assert.doesNotMatch(dev, /starts an unprivileged tag-create listener/u);
  // AGENTS.md must no longer claim the create event loads publish.yml from the default branch.
  assert.doesNotMatch(agents, /Creating the tag triggers `publish\.yml` through GitHub's `create` event/u);
  assert.match(agents, /selects `publish\.yml` through `workflow_run`, which GitHub loads from the protected default branch/u);
});

test("SEC-002: the remote tag is reconfirmed against the verified SHA before each irreversible publish", async () => {
  const publish = await Bun.file(join(root, ".github/workflows/publish.yml")).text();

  const nativeReconfirm = publish.indexOf("Reconfirm release tag before @bastani/atomic-natives publish");
  const nativePublish = publish.indexOf("Publish Atomic native packages to npm");
  const atomicReconfirm = publish.indexOf("Reconfirm release tag before @bastani/atomic publish");
  const atomicPublish = publish.indexOf("- name: Publish to npm");
  const finalReconfirm = publish.indexOf("Reconfirm release tag is immutable");
  const githubRelease = publish.indexOf("Create GitHub Release with binaries");

  for (const [label, index] of [
    ["native reconfirm", nativeReconfirm],
    ["native publish", nativePublish],
    ["atomic reconfirm", atomicReconfirm],
    ["atomic publish", atomicPublish],
    ["final reconfirm", finalReconfirm],
    ["github release", githubRelease],
  ] as const) {
    assert.ok(index >= 0, `missing step: ${label}`);
  }

  // Each reconfirm must precede exactly the irreversible side effect it guards.
  assert.ok(nativeReconfirm < nativePublish, "native reconfirm must precede native publish");
  assert.ok(nativePublish < atomicReconfirm, "atomic reconfirm must follow native publish");
  assert.ok(atomicReconfirm < atomicPublish, "atomic reconfirm must precede atomic publish");
  assert.ok(atomicPublish < finalReconfirm, "final reconfirm must precede GitHub Release");
  assert.ok(finalReconfirm < githubRelease, "final reconfirm must precede GitHub Release creation");

  // All three reconfirm steps route through the shared, tested helper and bind
  // the exact verified tag/SHA outputs from release-integrity.
  const helperInvocations = publish.match(/run: bun scripts\/reconfirm-release-tag\.ts/gu) ?? [];
  assert.equal(helperInvocations.length, 3, "expected three reconfirm-release-tag.ts invocations");
  assert.equal(
    (publish.match(/RELEASE_TAG: \$\{\{ needs\.release-integrity\.outputs\.tag \}\}\n\s+VERIFIED_SHA: \$\{\{ needs\.release-integrity\.outputs\.sha \}\}/gu) ?? []).length,
    3,
    "each reconfirm must bind needs.release-integrity.outputs.tag/sha exactly",
  );
  // Each pre-publish reconfirm is gated by the same registry-existence guard as its publish.
  const nativeBlock = publish.slice(nativeReconfirm, nativePublish);
  const atomicBlock = publish.slice(atomicReconfirm, atomicPublish);
  assert.match(nativeBlock, /if: steps\.native_registry\.outputs\.exists != 'true'/u);
  assert.match(atomicBlock, /if: steps\.registry\.outputs\.exists != 'true'/u);
});

test("SEC-003: docs state the exact npm provenance trust model without overclaiming the release SHA", async () => {
  const ci = await Bun.file(join(root, "docs/ci.md")).text();
  assert.match(ci, /### npm provenance trust model \(`workflow_run`\)/u);
  assert.match(ci, /identifies \*\*the protected default-branch execution of `publish\.yml`\*\*/u);
  assert.match(ci, /does \*\*not\*\*, and under `workflow_run` cannot, name the off-branch `Release <version>` tag commit/u);
  assert.match(ci, /Its source-commit digest is the default-branch tip, never the release SHA/u);
  assert.match(ci, /Required first-release verification/u);
  assert.match(ci, /Do not describe npm provenance as attesting the release tag SHA/u);
  // The deterministic integrity proof — not provenance — is what binds bytes to the release commit.
  assert.match(ci, /the deterministic integrity proof is what binds the published bytes to the release commit/u);
});
