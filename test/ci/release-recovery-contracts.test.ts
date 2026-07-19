import { test } from "bun:test";
import assert from "node:assert/strict";
import { $ } from "bun";
import { fileURLToPath } from "node:url";

type RecoveryFixture = {
  historicalWorkflowSha256: string;
  observedWorkflowRef: string;
  releaseBaseRef: string;
  releaseBaseSha: string;
  changelogSectionSha256: Record<string, string>;
};

const root = fileURLToPath(new URL("../..", import.meta.url));
const fixture = await Bun.file(`${root}/test/fixtures/release/0.9.10-alpha.1-recovery.json`).json() as RecoveryFixture;
const tag = "0.9.10-alpha.1";

function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

function releasedSection(text: string): string {
  const start = text.indexOf(`## [${tag}]`);
  assert.notEqual(start, -1, `missing ${tag} section`);
  const next = text.indexOf("\n## [", start + 1);
  return text.slice(start, next < 0 ? text.length : next + 1);
}

test("historical workflow bytes and graph prove attempt 2 cannot reach privileged jobs", async () => {
  const historical = await $`git show ${`${tag}:.github/workflows/publish.yml`}`.cwd(root).text();
  assert.equal(sha256(historical), fixture.historicalWorkflowSha256);
  assert.match(historical, /name: Publish\r?\n/u);
  assert.match(historical, /expected_workflow_ref="\$\{GITHUB_REPOSITORY\}\/\.github\/workflows\/publish\.yml@refs\/heads\/\$\{DEFAULT_BRANCH\}"/u);
  assert.match(historical, /\[\[ "\$WORKFLOW_REF" == "\$expected_workflow_ref" \]\] \|\| \{[^\n]*exit 1;/u);
  assert.notEqual(
    fixture.observedWorkflowRef,
    "bastani-inc/atomic/.github/workflows/publish.yml@refs/heads/main",
    "the immutable rerun must deterministically fail its first integrity gate",
  );

  const integrity = historical.slice(historical.indexOf("    release-integrity:"), historical.indexOf("    linux-binary-smoke:"));
  assert.doesNotMatch(integrity, /contents: write|id-token: write/u);
  const publish = historical.slice(historical.indexOf("    publish:"));
  assert.match(publish, /needs:[\s\S]*- release-integrity/u);
  assert.doesNotMatch(publish.slice(0, publish.indexOf("steps:")), /if:\s*always\(\)/u);
});

test("historical release commit pins the literal immutable base trailers", async () => {
  const message = await $`git show -s --format=%B ${tag}`.cwd(root).text();
  assert.equal(
    message,
    `Release ${tag}\n\nRelease-base-ref: ${fixture.releaseBaseRef}\nRelease-base-sha: ${fixture.releaseBaseSha}\n\n`,
  );
  assert.equal((await $`git show -s --format=%P ${tag}`.cwd(root).text()).trim(), fixture.releaseBaseSha);
});

test("every released 0.9.10-alpha.1 changelog section remains byte-for-byte unchanged", async () => {
  assert.equal(Object.keys(fixture.changelogSectionSha256).length, 8);
  for (const [path, expectedHash] of Object.entries(fixture.changelogSectionSha256)) {
    const current = await Bun.file(`${root}/${path}`).text();
    assert.equal(sha256(releasedSection(current)), expectedHash, path);
    const base = await $`git show ${`HEAD:${path}`}`.cwd(root).text();
    assert.equal(releasedSection(current), releasedSection(base), path);
  }
});

test("protected publisher executable path invokes both context and ancestry validators", async () => {
  const helper = await Bun.file(`${root}/scripts/verify-publish-context.ts`).text();
  const main = helper.slice(helper.indexOf("if (import.meta.main)"));
  assert.match(main, /const route = validatePublishContext\(context\);/u);
  assert.match(main, /verifyProtectedWorkflowAncestry\(context\.workflowSha, process\.env\.PROTECTED_DEFAULT_REF\);/u);

  const workflow = await Bun.file(`${root}/.github/workflows/publish-release.yml`).text();
  assert.match(workflow, /git fetch --no-tags origin "refs\/heads\/\$\{DEFAULT_BRANCH\}:\$\{PROTECTED_DEFAULT_REF\}"/u);
  assert.match(workflow, /bun scripts\/verify-publish-context\.ts/u);
});
