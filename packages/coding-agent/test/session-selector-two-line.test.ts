import assert from "node:assert/strict";
import { setKeybindings, visibleWidth } from "@bastani/atomic-tui";
import { beforeAll, beforeEach, describe, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionInfo } from "../src/core/session-manager.ts";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const HOUR = 3_600_000;
const FIXTURE_NOW = Date.now();

function makeSession(overrides: Partial<SessionInfo> & { id: string }): SessionInfo {
	return {
		path: overrides.path ?? `/tmp/${overrides.id}.jsonl`,
		id: overrides.id,
		cwd: overrides.cwd ?? "/work/project",
		name: overrides.name,
		...(overrides.hasName !== undefined ? { hasName: overrides.hasName } : {}),
		...(overrides.parentSessionPath !== undefined ? { parentSessionPath: overrides.parentSessionPath } : {}),
		created: overrides.created ?? new Date(FIXTURE_NOW - 3 * HOUR),
		modified: overrides.modified ?? new Date(FIXTURE_NOW - 2 * HOUR),
		messageCount: overrides.messageCount ?? 4,
		firstMessage: overrides.firstMessage ?? `first-${overrides.id}`,
		allMessagesText: overrides.allMessagesText ?? `text-${overrides.id}`,
		...(overrides.summary !== undefined ? { summary: overrides.summary } : {}),
		...(overrides.title !== undefined ? { title: overrides.title } : {}),
		...(overrides.detail !== undefined ? { detail: overrides.detail } : {}),
		...(overrides.messageColor !== undefined ? { messageColor: overrides.messageColor } : {}),
		...(overrides.resumeKind !== undefined ? { resumeKind: overrides.resumeKind } : {}),
		...(overrides.canDelete !== undefined ? { canDelete: overrides.canDelete } : {}),
	};
}

function strip(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b_[^\x07]*\x07/g, "");
}

function mount(
	sessions: SessionInfo[],
	options: {
		rename?: boolean;
		variant?: "sessions" | "runs" | "mixed";
		title?: string;
		canDelete?: boolean;
		keybindings?: KeybindingsManager;
		deleteSession?: (id: string) => Promise<void>;
		deleteWorkflow?: (runId: string) => Promise<void>;
		currentSession?: { id: string; directory: string };
		loader?: () => Promise<SessionInfo[]>;
		onCancel?: () => void;
		onSelect?: (session: SessionInfo) => void;
	} = {},
): SessionSelectorComponent {
	const keybindings = options.keybindings ?? new KeybindingsManager();
	const load = options.loader ?? (async () => sessions);
	return new SessionSelectorComponent(
		load,
		load,
		options.onSelect ?? (() => {}),
		options.onCancel ?? (() => {}),
		() => {},
		() => {},
		{
			keybindings,
			initialSessions: sessions,
			...(options.rename ? { renameSession: async () => {} } : {}),
			...(options.deleteSession ? { deleteSession: options.deleteSession } : {}),
			...(options.deleteWorkflow ? { deleteWorkflow: options.deleteWorkflow } : {}),
			...(options.variant ? { variant: options.variant } : {}),
			...(options.title ? { title: options.title } : {}),
			...(options.canDelete !== undefined ? { canDelete: options.canDelete } : {}),
		},
		options.currentSession,
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

	it("lists a backreference match and reports an invalid regex as no matches (#5554)", () => {
		const selector = mount([
			makeSession({ id: "twice", firstMessage: "say it twice", allMessagesText: "ship it ship it" }),
			makeSession({ id: "once", firstMessage: "say it once", allMessagesText: "ship it now" }),
		]);
		for (const ch of String.raw`re:^(.+) \1$`) selector.handleInput(ch);
		const matched = frame(selector);
		assert.ok(
			matched.some((line) => line.includes("say it twice")),
			matched.join("\n"),
		);
		assert.ok(!matched.some((line) => line.includes("say it once")), matched.join("\n"));

		const invalid = mount([makeSession({ id: "a" })]);
		for (const ch of "re:(") invalid.handleInput(ch);
		const lines = frame(invalid);
		assert.ok(
			lines.some((line) => line.includes('No matches for "re:("')),
			lines.join("\n"),
		);
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
		for (const variant of ["sessions", "runs"] as const) {
			const rowNonDeletable = mount([makeSession({ id: "a", canDelete: false })], { variant });
			assert.ok(!frame(rowNonDeletable).at(-2)!.includes("delete"));
			rowNonDeletable.handleInput("\x04");
			assert.ok(!frame(rowNonDeletable).some((line) => line.includes("Delete this")));
			rowNonDeletable.dispose();
		}
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
			selector.getSessionList().setSessions([{ ...original, path: "workflow-completed:run-a" }], true);
			assert.ok(frame(selector).some((line) => line.includes("Delete this workflow run?")));
			selector.handleInput("\r");
			selector.getSessionList().setSessions([{ ...original, path: "workflow-live:run-a" }], true);
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

		const sharedModified = new Date(Date.now() - 2 * HOUR);
		const firstFolder = makeSession({
			id: "shared-id",
			cwd: "/work/a",
			path: "/work/a/shared-id.jsonl",
			modified: sharedModified,
		});
		const secondFolder = makeSession({
			id: "shared-id",
			cwd: "/work/b",
			path: "/work/b/shared-id.jsonl",
			modified: sharedModified,
		});
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
	])(
		"Ctrl+C cancels list, search, preview, delete confirmation, help, and rename using $protocol input (#5256)",
		({ key }) => {
			for (const state of ["list", "search", "preview", "confirm", "help", "rename"] as const) {
				let cancelled = 0;
				const selector = mount([makeSession({ id: "a" })], {
					variant: "mixed",
					rename: true,
					deleteSession: async () => {},
					onCancel: () => cancelled++,
				});
				if (state === "search") selector.handleInput("z");
				else if (state === "preview") selector.handleInput(" ");
				else if (state === "confirm") selector.handleInput("\x04");
				else if (state === "help") selector.handleInput("?");
				else if (state === "rename") selector.handleInput("\x12");
				selector.handleInput(key);
				assert.equal(cancelled, 1, state);
				selector.dispose();
			}
		},
	);

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

	it("mixed picker titles Resume, groups Sessions first then Workflow runs with counts, sorts each group newest-first, and crosses groups with arrows (#5256)", () => {
		const now = Date.now();
		const olderSession = makeSession({
			id: "s-old",
			path: "/tmp/s-old.jsonl",
			firstMessage: "older session prompt",
			modified: new Date(now - 3 * HOUR),
		});
		const newerSession = makeSession({
			id: "s-new",
			path: "/tmp/s-new.jsonl",
			parentSessionPath: "/tmp/s-old.jsonl",
			firstMessage: "newer session prompt",
			modified: new Date(now - HOUR),
		});
		const olderWorkflow = makeSession({
			id: "wf-old",
			path: "workflow-durable:wf-old",
			resumeKind: "workflow",
			title: "goal · older workflow",
			detail: "paused · stage 1/3 · 4h ago",
			modified: new Date(now - 4 * HOUR),
			messageCount: 0,
		});
		const newerWorkflow = makeSession({
			id: "wf-new",
			path: "workflow-durable:wf-new",
			resumeKind: "workflow",
			title: "ralph · newer workflow",
			detail: "paused · stage 2/5 · 30m ago",
			modified: new Date(now - 30 * 60_000),
			messageCount: 0,
		});
		const chosen: string[] = [];
		const selector = mount([olderWorkflow, olderSession, newerWorkflow, newerSession], {
			variant: "mixed",
			onSelect: (row) => chosen.push(row.id),
		});
		const lines = frame(selector, 160);
		assert.ok(
			lines.some((line) => line.trim() === "Resume"),
			lines.join("\n"),
		);
		const sessionsGroupIndex = lines.findIndex((line) => line.trim() === "Sessions (2)");
		const newSessionIndex = lines.findIndex((line) => line.includes("newer session prompt"));
		const oldSessionIndex = lines.findIndex((line) => line.includes("older session prompt"));
		const workflowsGroupIndex = lines.findIndex((line) => line.trim() === "Workflow runs (2)");
		const newWorkflowIndex = lines.findIndex((line) => line.includes("ralph · newer workflow"));
		const oldWorkflowIndex = lines.findIndex((line) => line.includes("goal · older workflow"));
		assert.ok(sessionsGroupIndex >= 0, lines.join("\n"));
		assert.ok(sessionsGroupIndex < newSessionIndex && newSessionIndex < oldSessionIndex, lines.join("\n"));
		assert.ok(oldSessionIndex < workflowsGroupIndex && workflowsGroupIndex < newWorkflowIndex, lines.join("\n"));
		assert.ok(newWorkflowIndex < oldWorkflowIndex, lines.join("\n"));
		assert.ok(
			!lines[newSessionIndex]!.includes("└─") && !lines[newSessionIndex]!.includes("├─"),
			lines[newSessionIndex],
		);

		selector.handleInput("\x1b[B");
		assert.equal(selector.getSessionList().getSelectedSessionId(), "s-old");
		selector.handleInput("\x1b[B");
		assert.equal(selector.getSessionList().getSelectedSessionId(), "wf-new");
		selector.handleInput("\x1b[A");
		assert.equal(selector.getSessionList().getSelectedSessionId(), "s-old");
		selector.handleInput("\x1b[B");
		selector.handleInput("\r");
		assert.deepEqual(chosen, ["wf-new"]);
		selector.dispose();

		const sessionsOnly = frame(mount([newerSession], { variant: "mixed" }), 160);
		assert.ok(
			sessionsOnly.some((line) => line.trim() === "Sessions (1)"),
			sessionsOnly.join("\n"),
		);
		assert.ok(!sessionsOnly.some((line) => line.includes("Workflow runs")), sessionsOnly.join("\n"));

		const workflowsOnly = frame(mount([newerWorkflow], { variant: "mixed" }), 160);
		const zeroSessionsIndex = workflowsOnly.findIndex((line) => line.trim() === "Sessions (0)");
		const oneWorkflowIndex = workflowsOnly.findIndex((line) => line.trim() === "Workflow runs (1)");
		assert.ok(zeroSessionsIndex >= 0 && zeroSessionsIndex < oneWorkflowIndex, workflowsOnly.join("\n"));
	});

	it("mixed search filters both groups newest-first, and named filter keeps workflow rows (#5256)", () => {
		const now = Date.now();
		const s1 = makeSession({
			id: "s1",
			name: "alpha",
			hasName: true,
			firstMessage: "deploy pipeline alpha",
			allMessagesText: "deploy pipeline alpha",
			modified: new Date(now - 2 * HOUR),
		});
		const s2 = makeSession({
			id: "s2",
			firstMessage: "deploy pipeline beta",
			allMessagesText: "deploy pipeline beta",
			modified: new Date(now - HOUR),
		});
		const wf1 = makeSession({
			id: "wf1",
			path: "workflow-durable:wf1",
			resumeKind: "workflow",
			title: "deploy · release check",
			detail: "paused · stage 1/2",
			modified: new Date(now - 30 * 60_000),
		});
		const selector = mount([s1, s2, wf1], { variant: "mixed" });
		for (const ch of "deploy") selector.handleInput(ch);
		const searched = frame(selector, 160);
		const s2At = searched.findIndex((line) => line.includes("deploy pipeline beta"));
		const s1At = searched.findIndex((line) => line.includes("alpha"));
		const wfAt = searched.findIndex((line) => line.includes("deploy · release check"));
		assert.ok(s2At >= 0 && s2At < s1At && s1At < wfAt, searched.join("\n"));

		selector.handleInput("\x1b");
		selector.handleInput("\x0e");
		const namedLines = frame(selector, 160);
		assert.ok(
			namedLines.some((line) => line.trim() === "Sessions (1)"),
			namedLines.join("\n"),
		);
		assert.ok(
			namedLines.some((line) => line.trim() === "Workflow runs (1)"),
			namedLines.join("\n"),
		);
		assert.ok(!namedLines.some((line) => line.includes("deploy pipeline beta")), namedLines.join("\n"));
		selector.dispose();
	});

	it("mixed hints order core keys then live extras at 160 cols, collapse to core + ? keys at 80 cols, and open the ? help overlay (#5256)", () => {
		const modified = new Date(Date.now() - 2 * HOUR);
		const sessionRow = makeSession({ id: "s1", path: "/work/project/s1.jsonl", modified });
		const activeWorkflow = makeSession({
			id: "s1",
			path: "workflow-live:s1",
			cwd: "Live",
			modified,
			resumeKind: "workflow",
			canDelete: false,
			title: "demo · active workflow",
			detail: "paused · stage 1/2",
		});
		const inactiveWorkflow = makeSession({
			id: "wf-del",
			path: "workflow-durable:wf-del",
			cwd: "Durable",
			modified,
			resumeKind: "workflow",
			canDelete: true,
			title: "demo · durable workflow",
			detail: "failed · stage 2/2",
		});
		let cancelled = 0;
		const remapped = new KeybindingsManager({ "app.session.rename": "ctrl+e" });
		const selector = mount([sessionRow, activeWorkflow, inactiveWorkflow], {
			variant: "mixed",
			rename: true,
			keybindings: remapped,
			onCancel: () => cancelled++,
		});

		const wideHint = frame(selector, 160).at(-2)!.trim();
		assert.equal(
			wideHint,
			"space preview · enter resume · type to search · esc cancel · tab scope · ctrl+e rename · ctrl+d delete · ctrl+s sort · ctrl+n named · ctrl+p path · ? keys",
		);
		const col120Hint = frame(selector, 120).at(-2)!.trim();
		assert.equal(
			col120Hint,
			"space preview · enter resume · type to search · esc cancel · tab scope · ctrl+e rename · ctrl+d delete · ? keys",
		);
		const col80Hint = frame(selector, 80).at(-2)!.trim();
		assert.equal(col80Hint, "space preview · enter resume · type to search · esc cancel · ? keys");
		const col48Hint = frame(selector, 48).at(-2)!.trim();
		assert.equal(col48Hint, "enter resume · esc cancel · ? keys");

		selector.handleInput(" ");
		const preview160Hint = frame(selector, 160).at(-2)!.trim();
		assert.equal(
			preview160Hint,
			"space close preview · enter resume · type to search · esc close · tab scope · ctrl+e rename · ctrl+d delete · ctrl+s sort · ctrl+n named · ? keys",
		);
		const preview48Hint = frame(selector, 48).at(-2)!.trim();
		assert.equal(preview48Hint, "enter resume · esc close · ? keys");
		selector.handleInput(" ");

		selector.handleInput("\x04");
		assert.equal(frame(selector, 24).at(-2)!.trim(), "enter delete");
		selector.handleInput("\x1b");

		selector.handleInput("\x1b[B");
		const activeWfHint = frame(selector, 160).at(-2)!.trim();
		assert.ok(!activeWfHint.includes("rename"), activeWfHint);
		assert.ok(!activeWfHint.includes("delete"), activeWfHint);
		assert.ok(activeWfHint.includes("tab scope"), activeWfHint);
		assert.ok(activeWfHint.includes("named"), activeWfHint);
		assert.ok(!activeWfHint.includes("path"), activeWfHint);
		assert.ok(activeWfHint.includes("ctrl+s sort"), activeWfHint);
		assert.ok(activeWfHint.includes("? keys"), activeWfHint);

		selector.handleInput(" ");
		const wfPreview = frame(selector, 160).join("\n");
		assert.ok(wfPreview.includes("s1"), wfPreview);
		assert.ok(!wfPreview.includes("workflow-live:s1"), wfPreview);
		assert.ok(!wfPreview.includes("Live"), wfPreview);
		selector.handleInput(" ");

		selector.handleInput("\x1b[B");
		const durableWfHint = frame(selector, 160).at(-2)!.trim();
		assert.ok(durableWfHint.includes("ctrl+d delete"), durableWfHint);
		assert.ok(!durableWfHint.includes("rename"), durableWfHint);

		selector.handleInput("\x1b[A");
		selector.handleInput("\x1b[A");
		selector.handleInput("?");
		const helpLines = frame(selector, 80);
		assert.ok(
			helpLines.some((line) => line.includes("keys · resume")),
			helpLines.join("\n"),
		);
		assert.ok(
			helpLines.some((line) => line.includes("ctrl+e") && line.includes("rename")),
			helpLines.join("\n"),
		);
		assert.ok(
			helpLines.some((line) => line.includes("close this help")),
			helpLines.join("\n"),
		);
		selector.handleInput("\x1b");
		assert.equal(cancelled, 0);
		assert.ok(!frame(selector, 80).some((line) => line.includes("close this help")));

		for (const helpOpen of [false, true]) {
			if (helpOpen) selector.handleInput("?");
			for (const width of [1, 2, 8, 10, 20, 40, 80, 160]) {
				for (const line of selector.render(width)) {
					assert.ok(visibleWidth(line) <= width, `${width}: ${JSON.stringify(line)}`);
				}
			}
			if (helpOpen) selector.handleInput("\x1b");
		}
		selector.dispose();
	});

	it("mixed picker types ? into non-empty regex, token, and quoted-phrase queries without opening help or advertising dead ? keys (#5256)", () => {
		const now = Date.now();
		const usSession = makeSession({
			id: "s-color",
			path: "/work/project/s-color.jsonl",
			firstMessage: "fix color tone",
			allMessagesText: "fix color tone",
			modified: new Date(now - HOUR),
		});
		const questionSession = makeSession({
			id: "s-question",
			path: "/work/project/s-question.jsonl",
			firstMessage: "ship why now? check",
			allMessagesText: "ship why now? check in a?b mode",
			modified: new Date(now - 2 * HOUR),
		});
		const plainSession = makeSession({
			id: "s-plain",
			path: "/work/project/s-plain.jsonl",
			firstMessage: "ship why now check",
			allMessagesText: "ship why now check",
			modified: new Date(now - 3 * HOUR),
		});
		const ukWorkflow = makeSession({
			id: "wf-colour",
			path: "workflow-durable:wf-colour",
			resumeKind: "workflow",
			title: "audit · colour tokens",
			detail: "paused · stage 1/2",
			modified: new Date(now - 30 * 60_000),
		});
		let cancelled = 0;
		const selectedIds: string[] = [];
		const selector = mount([usSession, questionSession, plainSession, ukWorkflow], {
			variant: "mixed",
			onCancel: () => cancelled++,
			onSelect: (row) => selectedIds.push(row.id),
		});

		selector.handleInput("\x1b[B");
		assert.equal(selector.getSessionList().getSelectedSessionId(), "s-question");

		selector.handleInput("?");
		assert.ok(frame(selector, 80).some((line) => line.includes("keys · resume")));
		selector.handleInput("\x1b");
		assert.equal(cancelled, 0);
		assert.ok(!frame(selector, 80).some((line) => line.includes("keys · resume")));
		assert.equal(selector.getSessionList().getSelectedSessionId(), "s-question");

		for (const ch of "re:colou?r") selector.handleInput(ch);
		const regexLines = frame(selector, 160);
		assert.ok(
			regexLines.some((line) => line.includes("⌕ re:colou?r")),
			regexLines.join("\n"),
		);
		assert.ok(!regexLines.some((line) => line.includes("keys · resume")), regexLines.join("\n"));
		assert.ok(
			regexLines.some((line) => line.includes("fix color tone")),
			regexLines.join("\n"),
		);
		assert.ok(
			regexLines.some((line) => line.includes("audit · colour tokens")),
			regexLines.join("\n"),
		);
		assert.ok(!regexLines.some((line) => line.includes("ship why now")), regexLines.join("\n"));
		assert.ok(!regexLines.at(-2)!.includes("? keys"), regexLines.at(-2));
		assert.ok(!frame(selector, 80).at(-2)!.includes("? keys"), frame(selector, 80).at(-2));
		assert.ok(frame(selector, 80).at(-2)!.includes("f1 keys"), frame(selector, 80).at(-2));
		selector.handleInput("\x1bOP");
		assert.ok(frame(selector, 80).some((line) => line.includes("keys · resume")));
		assert.ok(frame(selector, 80).some((line) => line.includes("esc/f1") && line.includes("close this help")));
		selector.handleInput("\x1bOP");
		assert.ok(!frame(selector, 80).some((line) => line.includes("keys · resume")));

		selector.handleInput("\x1b");
		assert.equal(selector.getSessionList().getSelectedSessionId(), "s-color");
		assert.ok(frame(selector, 160).at(-2)!.includes("? keys"));
		assert.ok(frame(selector, 80).at(-2)!.includes("? keys"));

		for (const ch of "a?b") selector.handleInput(ch);
		const tokenLines = frame(selector, 160);
		assert.ok(
			tokenLines.some((line) => line.includes("⌕ a?b")),
			tokenLines.join("\n"),
		);
		assert.ok(!tokenLines.some((line) => line.includes("keys · resume")), tokenLines.join("\n"));
		assert.ok(!tokenLines.at(-2)!.includes("? keys"), tokenLines.at(-2));
		assert.ok(!frame(selector, 80).at(-2)!.includes("? keys"), frame(selector, 80).at(-2));
		for (let i = 0; i < 3; i++) selector.handleInput("\x7f");
		const restoredLines = frame(selector, 160);
		assert.ok(
			restoredLines.some((line) => line.includes("Search…")),
			restoredLines.join("\n"),
		);
		assert.equal(selector.getSessionList().getSelectedSessionId(), "s-question");
		assert.ok(restoredLines.at(-2)!.includes("? keys"), restoredLines.at(-2));

		for (const ch of '"why now?"') selector.handleInput(ch);
		const phraseLines = frame(selector, 160);
		assert.ok(
			phraseLines.some((line) => line.includes('⌕ "why now?"')),
			phraseLines.join("\n"),
		);
		assert.ok(!phraseLines.some((line) => line.includes("keys · resume")), phraseLines.join("\n"));
		assert.ok(
			phraseLines.some((line) => line.includes("ship why now? check")),
			phraseLines.join("\n"),
		);
		assert.ok(!phraseLines.some((line) => line.includes("ship why now check")), phraseLines.join("\n"));
		assert.ok(!phraseLines.at(-2)!.includes("? keys"), phraseLines.at(-2));
		selector.handleInput("\r");
		assert.deepEqual(selectedIds, ["s-question"]);
		selector.dispose();
	});

	it("mixed workflow deletion routes to deleteWorkflow, isolates pending/deleted ids from sessions, and refreshSessions preserves state (#5256)", async () => {
		let rows: SessionInfo[] = [
			makeSession({ id: "shared-id", path: "/work/project/shared-id.jsonl", firstMessage: "session row" }),
			makeSession({
				id: "shared-id",
				path: "workflow-durable:shared-id",
				resumeKind: "workflow",
				canDelete: true,
				title: "ralph · workflow row",
				detail: "paused · stage 1/2",
			}),
		];
		const deletedWorkflows: string[] = [];
		const deletedSessions: string[] = [];
		const resumed: string[] = [];
		let releaseWfDelete!: () => void;
		const wfDeletion = new Promise<void>((resolve) => {
			releaseWfDelete = resolve;
		});
		const selector = mount(rows, {
			variant: "mixed",
			currentSession: { id: "shared-id", directory: "/work/project" },
			loader: async () => rows,
			deleteSession: async (id) => {
				deletedSessions.push(id);
			},
			deleteWorkflow: async (runId) => {
				deletedWorkflows.push(runId);
				await wfDeletion;
			},
			onSelect: (row) => resumed.push(`${row.resumeKind ?? "session"}:${row.id}`),
		});

		selector.handleInput("\x1b[B");
		assert.ok(frame(selector, 160).at(-2)!.includes("ctrl+d delete"));
		selector.handleInput("\x04");
		assert.ok(
			frame(selector, 160).some((line) => line.includes("Delete this workflow run?")),
			frame(selector, 160).join("\n"),
		);
		selector.handleInput("\r");
		assert.deepEqual(deletedWorkflows, ["shared-id"]);
		assert.deepEqual(deletedSessions, []);

		selector.handleInput("\x1b[A");
		selector.handleInput("\r");
		assert.deepEqual(resumed, ["session:shared-id"]);

		releaseWfDelete();
		await new Promise((resolve) => setTimeout(resolve, 10));
		rows = [rows[0]!, { ...rows[1]!, path: "workflow-completed:shared-id", detail: "completed · 1m ago" }];
		await selector.refreshSessions();
		const afterRefresh = frame(selector, 160);
		assert.ok(
			afterRefresh.some((line) => line.includes("session row")),
			afterRefresh.join("\n"),
		);
		assert.ok(!afterRefresh.some((line) => line.includes("ralph · workflow row")), afterRefresh.join("\n"));
		selector.dispose();
	});

	it("handles Ctrl+N and Tab on workflow rows so named-only filter or folder scope never traps the picker (#5256)", () => {
		const unnamedSession = makeSession({ id: "s-unnamed", path: "/work/project/s-unnamed.jsonl" });
		const wfRow = makeSession({
			id: "wf-paused",
			path: "workflow-durable:wf-paused",
			resumeKind: "workflow",
			title: "ralph · paused workflow",
			detail: "paused · stage 1/2",
		});
		const selector = mount([unnamedSession, wfRow], { variant: "mixed", rename: true });
		try {
			selector.handleInput("\x0e");
			assert.equal(selector.getSessionList().getSelectedSessionId(), "wf-paused");
			assert.match(frame(selector, 120).join("\n"), /named only/);
			selector.handleInput("\x0e");
			assert.doesNotMatch(frame(selector, 120).join("\n"), /named only/);
			assert.match(frame(selector, 120).join("\n"), /Sessions \(1\)/);

			selector.handleInput("\x1b[B");
			assert.equal(selector.getSessionList().getSelectedSessionId(), "wf-paused");
			selector.handleInput("\t");
			assert.match(frame(selector, 120).join("\n"), /all folders/);
			selector.handleInput("\t");
			assert.match(frame(selector, 120).join("\n"), /this folder/);
		} finally {
			selector.dispose();
		}
	});

	it("keeps mixed hint live-key predicates accurate for current session, canDelete=false, deleting state, search, and single row (#5256)", () => {
		const activeSession = makeSession({ id: "cur", path: "/work/project/cur.jsonl" });
		const secondSession = makeSession({
			id: "s2",
			path: "/work/project/s2.jsonl",
			firstMessage: "alpha row",
			allMessagesText: "alpha row",
		});
		let releaseDelete!: () => void;
		const deleteGate = new Promise<void>((resolve) => {
			releaseDelete = resolve;
		});

		const singleRowPicker = mount([activeSession], {
			variant: "mixed",
			rename: true,
			canDelete: false,
			currentSession: { id: "cur", directory: "/work/project" },
		});
		try {
			const singleHint = frame(singleRowPicker, 160).at(-2)!.trim();
			assert.ok(!singleHint.includes("delete"), singleHint);
			assert.ok(!singleHint.includes("sort"), singleHint);
		} finally {
			singleRowPicker.dispose();
		}

		const picker = mount([activeSession, secondSession], {
			variant: "mixed",
			rename: true,
			currentSession: { id: "cur", directory: "/work/project" },
			deleteSession: () => deleteGate,
		});
		try {
			const curHint = frame(picker, 160).at(-2)!.trim();
			assert.ok(!curHint.includes("delete"), curHint);
			assert.ok(curHint.includes("sort"), curHint);

			picker.handleInput("\x1b[B");
			const s2Hint = frame(picker, 160).at(-2)!.trim();
			assert.ok(s2Hint.includes("ctrl+d delete"), s2Hint);
			assert.ok(s2Hint.includes("ctrl+r rename"), s2Hint);

			picker.handleInput("a");
			const searchHint = frame(picker, 160).at(-2)!.trim();
			assert.ok(!searchHint.includes("preview"), searchHint);
			picker.handleInput("\x1b");

			picker.handleInput("\x04");
			picker.handleInput("\r");
			const deletingHint = frame(picker, 160).at(-2)!.trim();
			assert.ok(!deletingHint.includes("enter resume"), deletingHint);
			assert.ok(!deletingHint.includes("rename"), deletingHint);
			assert.ok(!deletingHint.includes("delete"), deletingHint);
		} finally {
			releaseDelete();
			picker.dispose();
		}
	});
});

describe("mixed resume shortcut priority (#5256)", () => {
	it("keeps cancel and the help shortcut whenever both fit in a narrow picker (#5256)", () => {
		const picker = mount([makeSession({ id: "a" })], { variant: "mixed" });
		try {
			for (const width of [21, 22, 23, 24]) {
				const hint = frame(picker, width).at(-2)!.trim();
				assert.equal(hint, "esc cancel · ? keys", `width=${width}: ${hint}`);
			}
			assert.equal(frame(picker, 20).at(-2)!.trim(), "esc cancel");
		} finally {
			picker.dispose();
		}
	});

	it("keeps a workflow row selected when the named-session filter changes (#5256)", () => {
		const rows = [
			makeSession({ id: "unnamed" }),
			makeSession({ id: "named", name: "Named session" }),
			makeSession({ id: "run-a", resumeKind: "workflow", title: "First workflow" }),
			makeSession({ id: "run-b", resumeKind: "workflow", title: "Selected workflow" }),
		];
		const picker = mount(rows, { variant: "mixed" });
		try {
			for (let index = 0; index < 3; index++) picker.handleInput("\x1b[B");
			assert.match(frame(picker).join("\n"), /❯ Selected workflow/);
			for (let index = 0; index < 2; index++) {
				picker.handleInput("\x0e");
				assert.match(frame(picker).join("\n"), /❯ Selected workflow/);
			}
		} finally {
			picker.dispose();
		}
	});

	it("does not reload saved sessions after deleting a workflow row (#5256)", async () => {
		const session = makeSession({ id: "session" });
		const run = makeSession({ id: "workflow", resumeKind: "workflow" });
		let loads = 0;
		let deletes = 0;
		const picker = mount([session, run], {
			variant: "mixed",
			loader: async () => {
				loads++;
				return deletes ? [session] : [session, run];
			},
			deleteWorkflow: async () => {
				deletes++;
			},
		});
		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(loads, 1);
			picker.handleInput("\x1b[B");
			picker.handleInput("\x04");
			picker.handleInput("\r");
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(deletes, 1);
			assert.equal(loads, 1);
			picker.updateWorkflowSessions([]);
			assert.doesNotMatch(frame(picker).join("\n"), /first-workflow/);
			assert.match(frame(picker).join("\n"), /first-session/);
		} finally {
			picker.dispose();
		}
	});

	it("acts on the painted row after a refresh moves the selection, and keeps a surviving row selected (#5256)", () => {
		const session = makeSession({ id: "session" });
		const runA = makeSession({ id: "run-a", resumeKind: "workflow", title: "Run A" });
		const runB = makeSession({ id: "run-b", resumeKind: "workflow", title: "Run B" });
		const runC = makeSession({ id: "run-c", resumeKind: "workflow", title: "Run C" });
		const runD = makeSession({ id: "run-d", resumeKind: "workflow", title: "Run D" });
		const selected: string[] = [];
		const picker = mount([session, runA, runB, runC], {
			variant: "mixed",
			onSelect: (row) => selected.push(row.id),
		});
		try {
			while (!/❯ Run B/.test(frame(picker).join("\n"))) picker.handleInput("\x1b[B");
			picker.updateWorkflowSessions([runD, runA, runB, runC]);
			assert.match(frame(picker).join("\n"), /❯ Run B/);
			picker.updateWorkflowSessions([runD, runA, runC]);
			for (const key of ["\r", "\x1b[C"]) picker.handleInput(key);
			assert.deepEqual(selected, [], "Enter and → wait for the moved selection to be painted");
			const painted = frame(picker)
				.join("\n")
				.match(/❯ (Run [A-D])/)?.[1];
			assert.ok(painted, "a row is selected");
			picker.handleInput("\r");
			assert.deepEqual(selected, [`run-${painted.at(-1)!.toLowerCase()}`]);
		} finally {
			picker.dispose();
		}
	});

	it("keeps the painted run selected when a refresh adds a newer run above it, without a key press (#5256)", async () => {
		const runA = makeSession({ id: "run-a", resumeKind: "workflow", title: "Run A" });
		const runB = makeSession({ id: "run-b", resumeKind: "workflow", title: "Run B" });
		const runNew = makeSession({
			id: "run-new",
			resumeKind: "workflow",
			title: "Run New",
			modified: new Date(FIXTURE_NOW - HOUR),
		});
		for (const variant of ["mixed", "runs"] as const) {
			const selected: string[] = [];
			const picker = mount([runA, runB], { variant, onSelect: (row) => selected.push(row.id) });
			try {
				await new Promise<void>((resolve) => setImmediate(resolve));
				assert.match(frame(picker).join("\n"), /❯ Run A/, variant);
				picker.getSessionList().setSessions([runNew, runA, runB], false);
				assert.match(frame(picker).join("\n"), /❯ Run A/, `${variant}: the run the reader saw stays selected`);
				picker.handleInput("\r");
				assert.deepEqual(selected, ["run-a"], variant);
			} finally {
				picker.dispose();
			}
		}
	});

	it("keeps the painted run selected in the other scope after a refresh replaced the folder list's selection (#5256)", async () => {
		const run = (id: string, title: string, hoursAgo: number) =>
			makeSession({ id, resumeKind: "workflow", title, modified: new Date(FIXTURE_NOW - hoursAgo * HOUR) });
		const runA = run("run-a", "Run A", 2);
		const runB = run("run-b", "Run B", 2);
		const runC = run("run-c", "Run C", 2);
		const runD = run("run-d", "Run D", 1);
		const pendingRefresh = Promise.withResolvers<SessionInfo[]>();
		let currentLoads = 0;
		const picker = new SessionSelectorComponent(
			async () => (++currentLoads === 1 ? [runA] : pendingRefresh.promise),
			async () => [runC],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings: new KeybindingsManager(), initialSessions: [runA], variant: "mixed" },
		);
		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.match(frame(picker).join("\n"), /❯ Run A/);
			void picker.refreshSessions();
			picker.updateWorkflowSessions([runB]);
			picker.handleInput("\t");
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.match(frame(picker).join("\n"), /❯ Run C/);
			picker.updateWorkflowSessions([runD, runC]);
			assert.match(frame(picker).join("\n"), /❯ Run C/, "the run the reader saw stays selected");
		} finally {
			pendingRefresh.resolve([runA]);
			picker.dispose();
		}
	});

	it("cancels a delete confirmation whose run vanishes in a refresh instead of resuming another run (#5256)", async () => {
		const session = makeSession({ id: "session" });
		const runA = makeSession({ id: "run-a", resumeKind: "workflow", title: "Run A" });
		const runB = makeSession({ id: "run-b", resumeKind: "workflow", title: "Run B" });
		const runC = makeSession({ id: "run-c", resumeKind: "workflow", title: "Run C" });
		const selected: string[] = [];
		const deleted: string[] = [];
		const picker = mount([session, runA, runB, runC], {
			variant: "mixed",
			onSelect: (row) => selected.push(row.id),
			deleteWorkflow: async (runId) => {
				deleted.push(runId);
			},
		});
		try {
			while (!/❯ Run B/.test(frame(picker).join("\n"))) picker.handleInput("\x1b[B");
			picker.handleInput("\x04");
			assert.match(frame(picker).join("\n"), /Delete this workflow run\?/);
			picker.updateWorkflowSessions([runA, runC]);
			picker.handleInput("\r");
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.deepEqual(selected, [], "no other run resumes");
			assert.deepEqual(deleted, [], "no other run is deleted");
			assert.doesNotMatch(frame(picker).join("\n"), /Delete this workflow run\?/);
		} finally {
			picker.dispose();
		}
	});
	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));

	it("keeps rename available when help is remapped onto its shortcut", () => {
		const keys = new KeybindingsManager({ "app.keys.help": ["ctrl+r", "?"] });
		const picker = mount([makeSession({ id: "shortcut-session" })], {
			variant: "mixed",
			rename: true,
			canDelete: false,
			keybindings: keys,
		});
		try {
			const hint = frame(picker, 160).at(-2)!;
			assert.ok(hint.includes("ctrl+r rename"), hint);
			assert.ok(hint.includes("? keys"), hint);
			assert.ok(!hint.includes("ctrl+r/? keys"), hint);
			picker.handleInput("\x12");
			assert.match(frame(picker).join("\n"), /Rename Session/);
			picker.handleInput("\x1b");
			picker.handleInput("?");
			assert.match(frame(picker).join("\n"), /keys · resume/);
		} finally {
			picker.dispose();
		}
	});

	it("keeps Space preview available when help claims the same key", () => {
		const picker = mount([makeSession({ id: "space-preview" })], {
			variant: "mixed",
			canDelete: false,
			keybindings: new KeybindingsManager({ "app.keys.help": "space" }),
		});
		try {
			const hint = frame(picker).at(-2)!;
			assert.ok(hint.includes("space preview"), hint);
			assert.ok(!hint.includes("space keys"), hint);
			picker.handleInput(" ");
			assert.match(frame(picker).join("\n"), /Created/);
		} finally {
			picker.dispose();
		}
	});

	it("keeps Ctrl+C as cancellation when help claims the same key", () => {
		let cancelled = 0;
		const picker = mount([makeSession({ id: "ctrl-c-cancel" })], {
			variant: "mixed",
			canDelete: false,
			keybindings: new KeybindingsManager({ "app.keys.help": "ctrl+c" }),
			onCancel: () => cancelled++,
		});
		try {
			assert.ok(!frame(picker).at(-2)!.includes("ctrl+c keys"));
			picker.handleInput("\x03");
			assert.equal(cancelled, 1);
		} finally {
			picker.dispose();
		}
	});
});

describe("resume deletion completion after closing (#5256)", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));

	it.each(["success", "failure"] as const)(
		"does not refresh or render a closed picker after delete %s",
		async (outcome) => {
			const row = makeSession({
				id: "closed-delete",
				resumeKind: "workflow",
				path: "workflow-durable:closed-delete",
			});
			const gate = Promise.withResolvers<void>();
			let loads = 0;
			let renders = 0;
			let completed = 0;
			const load = async () => {
				loads++;
				return [row];
			};
			const picker = new SessionSelectorComponent(
				load,
				load,
				() => {},
				() => {},
				() => {},
				() => renders++,
				{
					initialSessions: [row],
					variant: "mixed",
					keybindings: new KeybindingsManager(),
					deleteWorkflow: async () => {
						try {
							await gate.promise;
						} finally {
							completed++;
						}
					},
				},
			);
			await new Promise<void>((resolve) => setImmediate(resolve));
			const operation = picker.getSessionList().onDeleteSession!(row.path, row);
			picker.dispose();
			const closedCounts = { loads, renders };
			if (outcome === "success") gate.resolve();
			else gate.reject(new Error("Deletion failed"));
			await operation;
			assert.equal(completed, 1);
			assert.deepEqual({ loads, renders }, closedCounts);
		},
	);

	it("hides delete in a mixed picker with canDelete disabled on non-current sessions and workflow runs (#5256)", () => {
		const picker = mount(
			[
				makeSession({ id: "s1", firstMessage: "alpha" }),
				makeSession({ id: "s2", firstMessage: "beta" }),
				makeSession({
					id: "wf-1",
					path: "workflow-durable:wf-1",
					resumeKind: "workflow",
					title: "deploy · release",
					detail: "paused · stage 1/2",
				}),
			],
			{
				variant: "mixed",
				rename: true,
				canDelete: false,
				deleteSession: async () => {},
				deleteWorkflow: async () => {},
				currentSession: { id: "current-other", directory: "/work/project" },
			},
		);
		try {
			assert.equal(picker.getSessionList().getSelectedSessionId(), "s1");
			const sessionHint = frame(picker, 300).at(-2)!;
			assert.doesNotMatch(sessionHint, /delete/);
			picker.handleInput("\x1b[B");
			picker.handleInput("\x1b[B");
			assert.equal(picker.getSessionList().getSelectedSessionId(), "wf-1");
			const workflowHint = frame(picker, 300).at(-2)!;
			assert.doesNotMatch(workflowHint, /delete/);
		} finally {
			picker.dispose();
		}
	});

	it("keeps sort listed in the mixed hint while a search query leaves one match (#5256)", () => {
		const picker = mount(
			[makeSession({ id: "s1", firstMessage: "alpha" }), makeSession({ id: "s2", firstMessage: "beta" })],
			{
				variant: "mixed",
				rename: true,
				deleteSession: async () => {},
			},
		);
		try {
			for (const ch of "alpha") picker.handleInput(ch);
			const hint = frame(picker, 300).at(-2)!;
			assert.match(hint, /ctrl\+s sort/);
		} finally {
			picker.dispose();
		}
	});
});
