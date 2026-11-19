import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { test, vi } from "vitest";
import { FooterDataProvider } from "../../packages/coding-agent/src/core/footer-data-provider.js";
import { FooterComponent } from "../../packages/coding-agent/src/modes/interactive/components/footer.js";
import { fakeFooterAgentSession } from "../helpers/footer-session.js";
import { writeFileEnsuringDir } from "../helpers/runtime.js";

test("shared task context resolves and watches the stage cwd branch without changing main context", async () => {
	const directory = mkdtempSync(join(tmpdir(), "task-context-"));
	const mainCwd = join(directory, "main");
	const stageCwd = join(directory, "stage");
	const mainHead = join(mainCwd, ".git/HEAD");
	const stageHead = join(stageCwd, ".git/HEAD");
	await writeFileEnsuringDir(mainHead, "ref: refs/heads/main\n");
	await writeFileEnsuringDir(stageHead, "ref: refs/heads/stage-branch\n");
	const provider = new FooterDataProvider(mainCwd);
	provider.setExtensionStatus("mcp", "MCP: 0/1 servers");
	provider.startGitWatcher();
	const session = fakeFooterAgentSession();
	session.sessionManager.getCwd = () => stageCwd;
	const footer = new FooterComponent(session, provider);
	let changes = 0;
	provider.onBranchChange(() => changes++);
	try {
		await vi.waitFor(() => assert.match(stripAnsi(footer.render(160).join("\n")), /stage \(stage-branch\)/));
		await vi.waitFor(() => assert.equal(provider.getGitBranch(), "main"));
		assert.match(stripAnsi(footer.render(160).join("\n")), /MCP: 0\/1 servers/);
		// Fresh directories may precede macOS watcher readiness. Keep publishing the
		// same branch until the subscribed provider observes it, without polling Git.
		const branchWatchSettlementMs = 5000;
		await vi.waitFor(
			async () => {
				await writeFileEnsuringDir(stageHead, "ref: refs/heads/stage-updated\n");
				assert.ok(changes > 0);
				assert.match(stripAnsi(footer.render(160).join("\n")), /stage \(stage-updated\)/);
			},
			{ timeout: branchWatchSettlementMs },
		);
		assert.equal(provider.getGitBranch(), "main");
	} finally {
		footer.dispose();
		provider.dispose();
		rmSync(directory, { recursive: true, force: true });
	}
});
