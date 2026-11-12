import assert from "node:assert/strict";
import { join } from "node:path";
import { test, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import { FooterComponent, formatCwdForFooter } from "../src/modes/interactive/components/footer.js";

// PR #2926: exercise the actual Windows path implementation on every test host.
vi.mock("node:path", async (importOriginal) => {
	const path = await importOriginal<typeof import("node:path")>();
	return { ...path, ...path.win32 };
});

test("Windows task context preserves native backslashes and the full owner metadata", () => {
	vi.stubEnv("HOME", "C:\\Users\\owner");
	const cwd = join(process.env.HOME!, "Documents/projects/atomic");
	const session = {
		state: { model: { id: "gpt-6-astra", provider: "openai-codex", reasoning: true }, thinkingLevel: "medium" },
		sessionManager: { getCwd: () => cwd },
		// The owner's identity line shows while its agent is idle (#4690).
		isStreaming: false,
	} as unknown as AgentSession;
	const footer = new FooterComponent(
		session,
		{
			getGitBranch: () => "main",
			getAvailableProviderCount: () => 2,
			getExtensionStatuses: () => new Map([["mcp", "MCP: 0/1 servers"]]),
			onBranchChange: () => () => {},
		},
		{ dim: (text) => text, muted: (text) => text, warning: (text) => text },
		() => true,
	);
	try {
		assert.equal(formatCwdForFooter(cwd, process.env.HOME), "~\\Documents\\projects\\atomic");
		assert.equal(formatCwdForFooter("D:\\other\\verbatim", process.env.HOME), "D:\\other\\verbatim");
		const context = `openai-codex/gpt-6-astra  medium • ${join("~", "Documents/projects/atomic")} (main)`;
		assert.equal(context, "openai-codex/gpt-6-astra  medium • ~\\Documents\\projects\\atomic (main)");
		assert.deepEqual(footer.render(120), [context, "MCP: 0/1 servers"]);
	} finally {
		footer.dispose();
		vi.unstubAllEnvs();
	}
});
