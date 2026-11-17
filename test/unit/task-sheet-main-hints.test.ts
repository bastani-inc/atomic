import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test } from "vitest";
import { FooterComponent } from "../../packages/coding-agent/src/modes/interactive/components/footer.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";

test("a task sheet hides inactive main-chat keys while retaining idle session information (#5224)", () => {
	initTheme("dark");
	let navigation = false;
	let working = false;
	const session = {
		get isStreaming() {
			return working;
		},
		isCompacting: false,
		isRetrying: false,
		isBashRunning: false,
		state: { model: { provider: "fixture", id: "local", reasoning: false }, thinkingLevel: "off" },
		sessionManager: { getCwd: () => "/workspace/project", getSessionName: () => "release" },
	};
	const footer = new FooterComponent(
		session as never,
		{
			getGitBranch: () => "main",
			getExtensionStatuses: () => new Map<string, string>(),
			getAvailableProviderCount: () => 1,
			onBranchChange: () => () => {},
		} as never,
		undefined,
		() => navigation,
		undefined,
		() => ["↓ 3 agents", "? keys"],
	);
	try {
		for (const width of [80, 160]) {
			navigation = false;
			working = false;
			assert.match(stripVTControlCharacters(footer.render(width).join("\n")), /↓ 3 agents · \? keys/);
			navigation = true;
			const idleSheet = stripVTControlCharacters(footer.render(width).join("\n"));
			assert.match(idleSheet, /local/);
			assert.doesNotMatch(idleSheet, /↓ 3 agents|\? keys/);
			working = true;
			assert.deepEqual(footer.render(width), []);
			navigation = false;
			assert.match(stripVTControlCharacters(footer.render(width).join("\n")), /↓ 3 agents · \? keys/);
		}
	} finally {
		footer.dispose();
	}
});
