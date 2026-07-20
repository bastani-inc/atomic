import { test } from "bun:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const workflowPath = join(root, ".github/workflows/publish.yml");

function jobBlock(workflow: string, name: string, next: string): string {
  const start = workflow.indexOf(`  ${name}:`);
  const end = workflow.indexOf(`  ${next}:`, start + 1);
  assert.ok(start >= 0 && end > start, `${name} job block must exist`);
  return workflow.slice(start, end);
}

test("release recovery defaults source_ref to the requested tag verbatim", async () => {
  const workflow = await Bun.file(workflowPath).text();
  assert.match(workflow, /tag:[\s\S]*required: true[\s\S]*source_ref:[\s\S]*required: false/);
  assert.match(
    workflow,
    /SOURCE_REF: \$\{\{ github\.event\.inputs\.source_ref \|\| github\.event\.inputs\.tag \|\| github\.ref_name \}\}/,
  );
});

test("integrity always verifies the tag while recovery builds the selected source_ref", async () => {
  const workflow = await Bun.file(workflowPath).text();
  const integrity = jobBlock(workflow, "integrity", "native-artifacts");
  assert.match(integrity, /ref: \$\{\{ env\.RELEASE_TAG \}\}/);
  assert.doesNotMatch(integrity, /ref: \$\{\{ env\.SOURCE_REF \}\}/);

  for (const [name, next] of [
    ["native-artifacts", "linux-binary-smoke"],
    ["linux-binary-smoke", "windows-binary-smoke"],
    ["windows-binary-smoke", "build"],
    ["build", "stage-github-release"],
  ] as const) {
    const job = jobBlock(workflow, name, next);
    assert.match(job, /ref: \$\{\{ env\.SOURCE_REF \}\}/, `${name} must consume the recovery source`);
    assert.doesNotMatch(job, /ref: \$\{\{ needs\.integrity\.outputs\.sha \}\}/);
  }
});

test("recovery stays tag-scoped and cannot cancel the matching publication", async () => {
  const workflow = await Bun.file(workflowPath).text();
  assert.match(workflow, /group: publish-\$\{\{ github\.event\.inputs\.tag \|\| github\.ref_name \}\}/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /gh release create "\$RELEASE_TAG" --verify-tag --draft/);
});
