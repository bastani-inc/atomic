import assert from "node:assert/strict";
import { setKeybindings, visibleWidth } from "@bastani/atomic-tui";
import { beforeAll, beforeEach, describe, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionInfo } from "../src/core/session-manager.ts";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const HOUR = 3_600_000;

function makeSession(overrides: Partial<SessionInfo> & { id: string }): SessionInfo {
	return {
		path: overrides.path ?? `/tmp/${overrides.id}.jsonl`,
		id: overrides.id,
		cwd: overrides.cwd ?? "/work/project",
		name: overrides.name,
		created: overrides.created ?? new Date(Date.now() - 3 * HOUR),
		modified: overrides.modified ?? new Date(Date.now() - 2 * HOUR),
		messageCount: overrides.messageCount ?? 4,
		firstMessage: overrides.firstMessage ?? `first-${overrides.id}`,
		allMessagesText: overrides.allMessagesText ?? `text-${overrides.id}`,
		...(overrides.summary !== undefined ? { summary: overrides.summary } : {}),
		...(overrides.title !== undefined ? { title: overrides.title } : {}),
		...(overrides.detail !== undefined ? { detail: overrides.detail } : {}),
		...(overrides.messageColor !== undefined ? { messageColor: overrides.messageColor } : {}),
	};
}

function strip(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b_[^\x07]*\x07/g, "");
}

function mount(
	sessions: SessionInfo[],
	options: {
		rename?: boolean;
		variant?: "sessions" | "runs";
		title?: string;
		canDelete?: boolean;
		onCancel?: () => void;
		onSelect?: (session: SessionInfo) => void;
	} = {},
): SessionSelectorComponent {
	const keybindings = new KeybindingsManager();
	return new SessionSelectorComponent(
		async () => sessions,
		async () => sessions,
		options.onSelect ?? (() => {}),
		options.onCancel ?? (() => {}),
		() => {},
		() => {},
		{
			keybindings,
			initialSessions: sessions,
			...(options.rename ? { renameSession: async () => {} } : {}),
			...(options.variant ? { variant: options.variant } : {}),
			...(options.title ? { title: options.title } : {}),
			...(options.canDelete !== undefined ? { canDelete: options.canDelete } : {}),
		},
	);
}

function frame(selector: SessionSelectorComponent, width = 160): string[] {
	return selector.render(width).map(strip);
}

describe("resume picker: one two-line design for sessions and workflow runs (#5224)", () => {
	beforeAll(() => {
		initTheme("dark");
	});
	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("titles the sessions picker and shows a search box", () => {
		const lines = frame(mount([makeSession({ id: "a" })]));
		assert.ok(
			lines.some((line) => line.trim().startsWith("Resume session")),
			lines.join("\n"),
		);
		assert.ok(
			lines.some((line) => line.includes("⌕") && line.includes("Search…")),
			lines.join("\n"),
		);
	});

	it("renders each session as a title line and a dim meta line: age · messages · summary (#5224)", () => {
		const lines = frame(
			mount([makeSession({ id: "a", firstMessage: "fix the login bug", messageCount: 42, summary: "OAuth loop" })]),
		);
		const titleIndex = lines.findIndex((line) => line.includes("fix the login bug"));
		assert.ok(titleIndex >= 0, lines.join("\n"));
		assert.match(lines[titleIndex]!, /❯ fix the login bug/);
		assert.match(lines[titleIndex + 1]!, /^\s+2h ago · 42 messages · OAuth loop\s*$/);
	});

	it("uses a row's own title and detail line when it has them (workflow runs)", () => {
		const lines = frame(
			mount(
				[
					makeSession({
						id: "r1",
						title: "ralph · fix the shipping benchmark",
						detail: "paused · stage 3/5 implement · 41m · $1.84",
						firstMessage: "ignored identity",
					}),
				],
				{ variant: "runs", title: "Resume workflow run" },
			),
		);
		assert.ok(lines.some((line) => line.trim() === "Resume workflow run"));
		const titleIndex = lines.findIndex((line) => line.includes("ralph · fix the shipping benchmark"));
		assert.ok(titleIndex >= 0, lines.join("\n"));
		assert.match(lines[titleIndex + 1]!, /^\s+paused · stage 3\/5 implement · 41m · \$1\.84\s*$/);
		assert.ok(!lines.some((line) => line.includes("ignored identity")));
	});

	it("shows one hint line with exactly the live keys of a sessions picker", () => {
		const lines = frame(mount([makeSession({ id: "a" }), makeSession({ id: "b" })], { rename: true }));
		const hint = lines.at(-2)!;
		for (const key of [
			"↑↓ select",
			"space preview",
			"enter resume",
			"tab all",
			"rename",
			"delete",
			"to search",
			"esc cancel",
		]) {
			assert.ok(hint.includes(key), `${key} missing from: ${hint}`);
		}
	});

	it("leaves out keys a picker does not have: rename without a rename handler, delete without deletion", () => {
		const hint = frame(mount([makeSession({ id: "a" }), makeSession({ id: "b" })], { canDelete: false })).at(-2)!;
		assert.ok(!hint.includes("rename"), hint);
		assert.ok(!hint.includes("delete"), hint);
	});

	it("drops scope, name-filter and path keys from a workflow-run picker", () => {
		const hint = frame(
			mount([makeSession({ id: "a", title: "x", detail: "paused" }), makeSession({ id: "b" })], {
				variant: "runs",
			}),
		).at(-2)!;
		assert.ok(!hint.includes("tab"), hint);
		assert.ok(!hint.includes("named"), hint);
		assert.ok(!hint.includes("path"), hint);
		assert.ok(hint.includes("enter resume"), hint);
	});

	it("space with an empty search toggles a preview of the selected row; esc closes it before cancelling", () => {
		let cancelled = false;
		const selector = mount(
			[makeSession({ id: "a", firstMessage: "fix the login bug", summary: "Debugged an OAuth redirect loop" })],
			{ onCancel: () => (cancelled = true) },
		);
		selector.handleInput(" ");
		const opened = frame(selector);
		assert.ok(
			opened.some((line) => line.includes("Created")),
			opened.join("\n"),
		);
		assert.ok(opened.some((line) => line.includes("/tmp/a.jsonl")));
		assert.ok(opened.at(-2)!.includes("space close preview"), opened.at(-2));
		selector.handleInput("\x1b");
		assert.equal(cancelled, false);
		assert.ok(!frame(selector).some((line) => line.includes("Created")));
		selector.handleInput("\x1b");
		assert.equal(cancelled, true);
	});

	it("preserves path tails and marks truncated text in previews (#5256)", () => {
		const folder = `/srv/${"deep-project/".repeat(15)}app`;
		const selector = mount([
			makeSession({
				id: "long-preview",
				cwd: folder,
				path: `${folder}/session-file-name.jsonl`,
				firstMessage: "TITLE ".repeat(60),
				summary: "SUMMARY ".repeat(80),
			}),
		]);
		selector.handleInput(" ");
		const preview = frame(selector, 60).filter((line) => line.startsWith("  │"));
		assert.ok(
			preview.some((line) => line.includes("session-file-name.jsonl")),
			preview.join("\n"),
		);
		assert.ok(
			preview.some((line) => /TITLE.*…\s*│/.test(line)),
			preview.join("\n"),
		);
		assert.ok(
			preview.some((line) => /SUMMARY.*…\s*│/.test(line)),
			preview.join("\n"),
		);
		selector.dispose();
	});

	it("keeps a workflow row locked if refresh changes its catalog kind during deletion (#5256)", async () => {
		const original = makeSession({ id: "run-a", path: "workflow-durable:run-a" });
		const resumed: string[] = [];
		let release!: () => void;
		const deletion = new Promise<void>((resolve) => {
			release = resolve;
		});
		const selector = mount([original], { variant: "runs", onSelect: (row) => resumed.push(row.id) });
		selector.getSessionList().onDeleteSession = async () => {
			await deletion;
		};
		try {
			selector.handleInput("\x04");
			selector.handleInput("\r");
			selector.getSessionList().setSessions([{ ...original, path: "workflow-completed:run-a" }], true);
			const rendered = frame(selector);
			assert.ok(
				rendered.some((line) => line.includes("Deleting…")),
				rendered.join("\n"),
			);
			assert.ok(!rendered.at(-2)!.includes("enter resume"), rendered.at(-2));
			selector.handleInput("\r");
			assert.deepEqual(resumed, []);
		} finally {
			release();
			selector.dispose();
		}

		// Ordinary sessions keep path identity when IDs repeat across project folders
		const firstFolder = makeSession({ id: "shared-id", cwd: "/work/a", path: "/work/a/shared-id.jsonl" });
		const secondFolder = makeSession({ id: "shared-id", cwd: "/work/b", path: "/work/b/shared-id.jsonl" });
		const resumedPaths: string[] = [];
		let releaseSession!: () => void;
		const sessionDeletion = new Promise<void>((resolve) => {
			releaseSession = resolve;
		});
		const sessionSelector = mount([firstFolder, secondFolder], {
			onSelect: (row) => resumedPaths.push(row.path),
		});
		sessionSelector.getSessionList().onDeleteSession = async () => {
			await sessionDeletion;
		};
		try {
			sessionSelector.handleInput("\x04");
			sessionSelector.handleInput("\r");
			sessionSelector.handleInput("\x1b[B");
			sessionSelector.handleInput("\r");
			assert.deepEqual(resumedPaths, ["/work/b/shared-id.jsonl"]);
		} finally {
			releaseSession();
			sessionSelector.dispose();
		}
	});

	it("space types into a non-empty search instead of previewing", () => {
		const selector = mount([makeSession({ id: "a", firstMessage: "fix the login bug" })]);
		for (const ch of "fix") selector.handleInput(ch);
		selector.handleInput(" ");
		selector.handleInput("t");
		const lines = frame(selector);
		assert.ok(
			lines.some((line) => line.includes("⌕ fix t")),
			lines.join("\n"),
		);
		assert.ok(!lines.some((line) => line.includes("Created")));
	});

	it("esc clears a non-empty search before it cancels", () => {
		let cancelled = false;
		const selector = mount([makeSession({ id: "a" })], { onCancel: () => (cancelled = true) });
		selector.handleInput("z");
		assert.ok(frame(selector).at(-2)!.includes("esc clear"));
		selector.handleInput("\x1b");
		assert.equal(cancelled, false);
		assert.ok(frame(selector).some((line) => line.includes("Search…")));
		selector.handleInput("\x1b");
		assert.equal(cancelled, true);
	});

	it.each([
		{ protocol: "legacy", key: "\x03" },
		{ protocol: "Kitty", key: "\x1b[99;5u" },
		{ protocol: "modifyOtherKeys", key: "\x1b[27;5;99~" },
	])("Ctrl+C cancels searches and previews using $protocol input (#5256)", ({ key }) => {
		for (const state of ["search", "preview"] as const) {
			let cancelled = 0;
			const selector = mount([makeSession({ id: "a" })], { onCancel: () => cancelled++ });
			selector.handleInput(state === "search" ? "z" : " ");
			selector.handleInput(key);
			assert.equal(cancelled, 1, state);
			selector.dispose();
		}
	});

	it("names the empty state for each picker kind", () => {
		const sessions = frame(mount([]));
		assert.ok(
			sessions.some((line) => line.includes("No sessions in this folder")),
			sessions.join("\n"),
		);
		const runs = frame(mount([], { variant: "runs" }));
		assert.ok(
			runs.some((line) => line.includes("No workflow runs to resume")),
			runs.join("\n"),
		);
	});

	it("keeps resume headers inside the terminal after a narrow resize (#5256)", () => {
		const selector = mount([makeSession({ id: "a" })]);
		selector.handleInput(" ");
		for (const width of [1, 2, 8, 10, 20, 40]) {
			for (const line of selector.render(width)) {
				assert.ok(visibleWidth(line) <= width, `${width}: ${JSON.stringify(line)}`);
			}
		}
		selector.dispose();
	});

	for (const width of [80, 160]) {
		it(`never draws past ${width} columns, with long titles, summaries and paths`, () => {
			const selector = mount([
				makeSession({
					id: "a",
					firstMessage: "x".repeat(300),
					summary: "y".repeat(300),
					cwd: `/${"z".repeat(200)}`,
				}),
				makeSession({ id: "b", title: "t".repeat(300), detail: "d".repeat(300) }),
			]);
			selector.handleInput(" ");
			for (const line of selector.render(width))
				assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);
		});
	}
});
