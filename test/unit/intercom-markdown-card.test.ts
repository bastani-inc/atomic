import assert from "node:assert/strict";
import { stripTerminalSequences, visibleWidth } from "@bastani/atomic-tui";
import { test } from "vitest";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import type { Message, SessionInfo } from "../../packages/intercom/types.ts";
import { InlineMessageComponent } from "../../packages/intercom/ui/inline-message.ts";

const from: SessionInfo = {
	id: "peer-session",
	name: "reviewer",
	model: "fixture/model",
	cwd: "/workspace",
	pid: 1,
	startedAt: 1,
	lastActivity: 1,
};

function message(text: string): Message {
	return { id: "markdown-message", timestamp: 1, content: { text } };
}

for (const themeName of ["dark", "light"] as const) {
	test(`Intercom message bodies render markdown without executing peer terminal controls (${themeName}, #5224)`, () => {
		initTheme(themeName, false);
		const body =
			"**Historical supervisor update**\n\n- Inspect `sample.ts`\n\n```text\n**literal markers**\n```\n\u001b]52;c;c2FtcGxl\u0007Safe text";
		const component = new InlineMessageComponent(from, message(body), theme);
		for (const width of [80, 160]) {
			const lines = component.render(width);
			const raw = lines.join("\n");
			const plain = stripTerminalSequences(raw);
			assert.doesNotMatch(plain, /\*\*Historical supervisor update\*\*/);
			assert.match(plain, /Historical supervisor update/);
			assert.match(plain, /\*\*literal markers\*\*/);
			assert.doesNotMatch(plain, /`sample\.ts`/);
			assert.match(plain, /Safe text/);
			assert.ok(!raw.includes("\u001b]52;"));
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
		}
	});
}
