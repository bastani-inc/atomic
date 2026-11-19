import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@bastani/atomic-ai/compat";
import { afterEach, beforeEach, test } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { withWorktreeRestoreNotices } from "../src/core/resume/path-mapping.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { isSyntheticPath } from "../src/core/source-info.js";

const NO_BUILTINS = { subagents: false, mcp: false, "web-access": false, intercom: false } as const;

let tempDir: string;
let agentDir: string;
beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "atomic-restore-notices-"));
	agentDir = join(tempDir, "agent");
	mkdirSync(agentDir, { recursive: true });
});
afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

async function openSession() {
	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd: tempDir,
		agentDir,
		settingsManager,
		extensionFactories: [() => {}],
	});
	await resourceLoader.reload();
	const { session, extensionsResult } = await createAgentSession({
		cwd: tempDir,
		agentDir,
		model: getModel("anthropic", "claude-sonnet-4-5")!,
		settingsManager,
		sessionManager: SessionManager.inMemory(),
		resourceLoader,
		builtins: NO_BUILTINS,
	});
	assert.deepEqual(
		extensionsResult.extensions.map((extension) => extension.path).filter((path) => !isSyntheticPath(path)),
		[],
	);
	return session;
}

const NOTICE =
	"Restored /node-a/repo into /node-b/worktree at its recorded commit 0123456789ab with 0 of the 1 change sets of snapshot abcdef012345. Not restored: change set 0.";

test("a session opened in a run whose checkout was restored in part is told what is missing (#4738)", async () => {
	const session = await withWorktreeRestoreNotices([NOTICE], openSession);
	try {
		const section = /<worktree_restore>\n([\s\S]*?)\n<\/worktree_restore>/.exec(session.systemPrompt)?.[1];
		assert.ok(section !== undefined, session.systemPrompt);
		assert.ok(section.includes(`- ${NOTICE}`), section);
		assert.doesNotMatch(section, /fail/i);
	} finally {
		session.dispose();
	}
});

test("a session opened outside such a run has no checkout section (#4738)", async () => {
	const session = await openSession();
	try {
		assert.equal(session.systemPrompt.includes("<worktree_restore>"), false);
	} finally {
		session.dispose();
	}
});

test("a notice an outer run already gives is not repeated for a run nested in it (#4738)", async () => {
	const session = await withWorktreeRestoreNotices([NOTICE], () => withWorktreeRestoreNotices([NOTICE], openSession));
	try {
		assert.equal(session.systemPrompt.split(NOTICE).length - 1, 1);
	} finally {
		session.dispose();
	}
});
