import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { canonicalDirectory, isSdkDurableRunInScope } from "../../packages/workflows/src/durable/sdk-recovery-scope.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function symlinkedProject(): { real: string; link: string } {
	const root = mkdtempSync(join(tmpdir(), "atomic-recovery-scope-"));
	roots.push(root);
	const real = join(root, "project");
	mkdirSync(real);
	const link = join(root, "project-link");
	symlinkSync(real, link, "junction");
	return { real, link };
}

test("startup recovery matches a run recorded through a symlinked project directory", () => {
	const { real, link } = symlinkedProject();
	assert.equal(canonicalDirectory(link), canonicalDirectory(real));
	assert.equal(
		isSdkDurableRunInScope(
			{
				workflowId: "run-1",
				name: "wf",
				inputs: {},
				status: "running",
				createdAt: 1,
				updatedAt: 1,
				completedCheckpoints: 1,
				pendingPrompts: 0,
				modelOwner: "session",
				invocationCwd: link,
			},
			real,
		),
		true,
	);
});

test("startup recovery keeps distinct project directories apart", () => {
	const { real } = symlinkedProject();
	assert.notEqual(canonicalDirectory(real), canonicalDirectory(join(real, "..")));
});
