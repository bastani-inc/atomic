import { setKeybindings, stripTerminalSequences } from "@bastani/atomic-tui";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionInfo } from "../src/core/session-manager.ts";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function makeSession(overrides: Partial<SessionInfo> & { id: string }): SessionInfo {
	return {
		path: overrides.path ?? `/tmp/${overrides.id}.jsonl`,
		id: overrides.id,
		cwd: overrides.cwd ?? "",
		name: overrides.name,
		created: overrides.created ?? new Date(0),
		modified: overrides.modified ?? new Date(0),
		messageCount: overrides.messageCount ?? 1,
		firstMessage: overrides.firstMessage ?? `first-${overrides.id}`,
		allMessagesText: overrides.allMessagesText ?? `text-${overrides.id}`,
		...(overrides.summary !== undefined ? { summary: overrides.summary } : {}),
	};
}

function renderRows(sessions: SessionInfo[], width = 160): string {
	const keybindings = new KeybindingsManager();
	const selector = new SessionSelectorComponent(
		async () => sessions,
		async () => [],
		() => {},
		() => {},
		() => {},
		() => {},
		{ showRenameHint: false, keybindings, initialSessions: sessions },
	);
	return selector.render(width).join("\n");
}

describe("session selector summary column", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("shows the summary in its own column without displacing the first message", () => {
		const frame = renderRows([
			makeSession({ id: "a", firstMessage: "fix the login bug", summary: "Debugged an OAuth redirect loop" }),
		]);
		expect(frame).toContain("fix the login bug");
		expect(frame).toContain("Debugged an OAuth redirect loop");
	});

	it("keeps a user-set session name visible alongside the summary", () => {
		const frame = renderRows([
			makeSession({ id: "b", name: "auth-work", summary: "Debugged an OAuth redirect loop" }),
		]);
		expect(frame).toContain("auth-work");
		expect(frame).toContain("Debugged an OAuth redirect loop");
	});

	it("shows no placeholder for a row without a summary, even when others have one (#5224)", () => {
		const frame = renderRows([
			makeSession({ id: "c", firstMessage: "fix the login bug" }),
			makeSession({ id: "c2", firstMessage: "other work", summary: "Refactored the session picker" }),
		]);
		expect(frame).toContain("fix the login bug");
		expect(frame).toContain("Refactored the session picker");
		expect(frame).not.toContain("No summary available.");
	});

	it("treats a whitespace-only summary as absent", () => {
		const frame = renderRows([makeSession({ id: "d", summary: "   " })]);
		expect(stripTerminalSequences(frame)).toMatch(/1 message\s*(\n|$)/);
	});

	it("renders no summary column when no listed session has one", () => {
		const frame = renderRows([
			makeSession({ id: "f", firstMessage: "fix the login bug" }),
			makeSession({ id: "g", firstMessage: "other work" }),
		]);
		expect(frame).toContain("fix the login bug");
		expect(frame).not.toContain("No summary available.");
	});

	it("leaves the summary out when the line has too little room for it", () => {
		const frame = renderRows(
			[
				makeSession({ id: "e", firstMessage: "fix the login bug", summary: "x".repeat(80) }),
				makeSession({ id: "e2" }),
			],
			40,
		);
		expect(frame).not.toContain("No summary available.");
	});
});
