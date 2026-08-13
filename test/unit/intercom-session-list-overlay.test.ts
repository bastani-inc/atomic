import assert from "node:assert/strict";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import type { Message, SessionInfo } from "../../packages/intercom/types.ts";
import { InlineMessageComponent } from "../../packages/intercom/ui/inline-message.ts";
import { SessionListOverlay } from "../../packages/intercom/ui/session-list.ts";

const CURRENT_ID = "f996d39d-5efd-41f7-8b01-22769b77873f";
const OTHER_ID = "1a2b3c4d-1111-4222-8333-123456789abc";
const REPLY_ID = "abcdef12-3456-4789-8abc-def012345678";

beforeAll(() => {
	initTheme("dark");
});

function session(id: string, name: string, cwd = "/workspace/project"): SessionInfo {
	return {
		id,
		name,
		cwd,
		model: "test-model",
		pid: 1234,
		startedAt: 1,
		lastActivity: 2,
	};
}

function plain(lines: string[]): string[] {
	return lines.map(stripTerminalSequences);
}

function makeOverlay(): SessionListOverlay {
	const current = session(CURRENT_ID, "planner");
	const other = session(OTHER_ID, "worker");
	return new SessionListOverlay(theme, new KeybindingsManager(), current, [other], () => {});
}

test("session-list overlay keeps full IDs accessible while fitting every rendered row", () => {
	for (const width of [34, 50, 80]) {
		const rendered = plain(makeOverlay().render(width));
		const expectedWidth = Math.max(36, Math.min(width - 2, 88));
		for (const line of rendered) {
			assert.ok(
				visibleWidth(line) <= expectedWidth,
				`rendered line exceeds the ${expectedWidth}-column overlay at width ${width}: ${line}`,
			);
		}

		const output = rendered.join("\n");
		assert.match(output, /planner/);
		assert.match(output, /worker/);
		assert.match(output, /\/workspace\/project/);
		assert.doesNotMatch(output, new RegExp(`${CURRENT_ID.slice(0, 8)}\\)`));
		assert.doesNotMatch(output, new RegExp(`${OTHER_ID.slice(0, 8)}\\)`));

		if (width === 34) {
			for (const id of [CURRENT_ID, OTHER_ID]) {
				const idLine = rendered.find((line) => line.includes(id.slice(0, 8)));
				assert.ok(idLine?.includes("…"), `narrow row for ${id} should show a visible ellipsis`);
			}
			assert.doesNotMatch(output, new RegExp(CURRENT_ID));
			assert.doesNotMatch(output, new RegExp(OTHER_ID));
		} else {
			assert.match(output, new RegExp(CURRENT_ID));
			assert.match(output, new RegExp(OTHER_ID));
		}
	}
});

test("inline-message marks clipped full sender and reply IDs with visible ellipses", () => {
	const from = session(CURRENT_ID, "");
	const message: Message = {
		id: "01234567-89ab-4cde-8fab-0123456789ab",
		timestamp: 1,
		replyTo: REPLY_ID,
		expectsReply: false,
		content: { text: "message body" },
	};
	const rendered = plain(new InlineMessageComponent(from, message, theme).render(34));
	const output = rendered.join("\n");

	assert.match(output, /From: .*…/);
	assert.match(output, /Reply to .*…/);
	for (const line of rendered) {
		assert.ok(visibleWidth(line) <= 34, `inline-message row exceeds 34 columns: ${line}`);
	}
});
