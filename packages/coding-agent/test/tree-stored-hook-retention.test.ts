/**
 * #5554: an explicit /tree on a session whose history stays on disk, and a `session_before_tree` hook that is handed the
 * archived branch it abandons, hold that history only while they use it. Nothing the tree read or the hook was given
 * outlives the selector and the navigation.
 */
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import v8 from "node:v8";
import vm from "node:vm";
import { Container, setKeybindings } from "@bastani/atomic-tui";
import { afterEach, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { StoredTreeView } from "../src/modes/interactive/components/stored-tree-view.js";
import { TreeSelectorComponent } from "../src/modes/interactive/components/tree-selector.ts";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.ts";
import "../src/modes/interactive/interactive-session-routing.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

function resolveCollect(): () => void {
	const existing = (globalThis as { gc?: () => void }).gc;
	if (typeof existing === "function") return existing;
	v8.setFlagsFromString("--expose-gc");
	try {
		return vm.runInNewContext("gc") as () => void;
	} finally {
		v8.setFlagsFromString("--no-expose-gc");
	}
}
const collect = resolveCollect();

async function settle(): Promise<void> {
	for (let round = 0; round < 6; round++) {
		await new Promise((resolve) => setTimeout(resolve, 10));
		collect();
	}
}

/** Weak references to a view, a tenth of its outline rows and every preview it holds. A separate frame, so no local
 * of the test's own suspended frame keeps one of them alive. */
function sampleView(view: StoredTreeView, sampled: [string, WeakRef<object>][]) {
	let previews = 0;
	let n = 0;
	sampled.push(["view", new WeakRef(view)]);
	for (const [id, row] of view.rows) {
		if (n++ % 10 === 0) sampled.push([`outline row ${id}`, new WeakRef(row)]);
		const preview = view.peek(id);
		if (!preview) continue;
		previews++;
		sampled.push([`preview ${id}`, new WeakRef(preview)], [`previewed entry ${id}`, new WeakRef(preview.entry)]);
	}
	return { previews, rows: view.rows.size };
}

const harnesses: Harness[] = [];
afterEach(async () => {
	while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	vi.restoreAllMocks();
});

test("a stored /tree and the archived branch a session_before_tree hook was given are released after it closes (#5554)", async () => {
	initTheme("dark", false);
	setKeybindings(new KeybindingsManager());
	const store = new MemorySessionStore();
	const manager = await SessionManager.create(store, "/project");
	const archived: string[] = [];
	const answers: string[] = [];
	for (let i = 0; i < 40; i++) {
		archived.push(
			await manager.appendMessage({
				role: "user",
				content: `archived question ${i} ${"q".repeat(2000)}`,
				timestamp: i,
			}),
		);
		const answer = await manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: `archived answer ${i} ${"a".repeat(2000)}` }],
			api: "faux",
			provider: "faux",
			model: "faux",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: i,
		});
		answers.push(answer);
	}
	await manager.appendCompaction("clear", null, 10, {
		strategy: "verbatim-lines",
		backend: "summary",
	} as unknown as Parameters<SessionManager["appendCompaction"]>[3]);
	await manager.appendMessage({ role: "user", content: "current", timestamp: 100 });
	const target = archived[20]!;
	assert.equal(manager.getEntry(target), undefined, "the archived branch stays on disk");

	// Weak references only: the test itself must not keep anything it samples alive.
	const sampled: [string, WeakRef<object>][] = [];
	let hookEntries = 0;
	const harness = await createHarness({
		sessionManager: manager,
		settings: { branchSummary: { skipPrompt: true } },
		extensionFactories: [
			(atomic) => {
				atomic.on("session_before_tree", (event) => {
					const { entriesToSummarize } = event.preparation;
					hookEntries = entriesToSummarize.length;
					sampled.push(["hook preparation", new WeakRef(event.preparation)]);
					for (const entry of entriesToSummarize)
						if (entry.type === "message" && JSON.stringify(entry.message).includes("archived"))
							sampled.push([`hook entry ${entry.id}`, new WeakRef(entry)]);
				});
			},
		],
	});
	harnesses.push(harness);

	let opened: StoredTreeView | undefined;
	const open = StoredTreeView.open.bind(StoredTreeView);
	const spy = vi.spyOn(StoredTreeView, "open").mockImplementation(async (m) => {
		const result = await open(m);
		opened = result.view;
		return result;
	});
	let mounted: { component: unknown; dispose?: () => void } | undefined;
	let renders = 0;
	const errors: string[] = [];
	const mode = {
		ensureDeferredStartupComplete: async () => {},
		get sessionManager() {
			return harness.session.sessionManager;
		},
		session: harness.session,
		settingsManager: harness.settingsManager,
		ui: { terminal: { rows: 40 }, requestRender: () => renders++ },
		showSelector(create: Parameters<InteractiveModeBase["showSelector"]>[0]) {
			mounted = create(() => {
				mounted?.dispose?.();
				mounted = undefined;
			});
		},
		showError: (message: string) => errors.push(message),
		showStatus: () => {},
		defaultEditor: { onEscape: undefined },
		chatContainer: new Container(),
		renderInitialMessages: () => {},
		editor: { getText: () => "", setText: () => {} },
		flushCompactionQueue: async () => {},
	} as unknown as InteractiveModeBase;

	await InteractiveModeBase.prototype.showTreeSelector.call(mode, target);
	assert.ok(mounted?.component instanceof TreeSelectorComponent);
	let view = opened;
	opened = undefined;
	// The spy records what it returned; forget it so only Atomic's own references remain.
	spy.mockClear();
	spy.mockRestore();
	assert.ok(view, "the tree is read from the store");
	let selector: TreeSelectorComponent | undefined = mounted.component;
	const screen = () => stripVTControlCharacters(selector!.render(120).join("\n"));
	selector.render(120);
	await vi.waitFor(() => assert.match(screen(), /user: archived question 20 q/));
	sampled.push(["selector", new WeakRef(selector)]);
	const { previews, rows } = sampleView(view, sampled);
	assert.ok(previews >= 10, "a screen of archived rows was read");

	// Choose the archived message: the selector closes, then the session navigates and runs the hook.
	selector.handleInput("\r");
	selector = undefined;
	// Choosing a user message moves the leaf to the answer before it and offers the message for editing.
	await vi.waitFor(() => assert.equal(harness.session.sessionManager.getLeafId(), answers[19]));
	assert.ok(hookEntries > 0, "the hook ran");
	assert.equal(mounted, undefined);
	assert.deepEqual(errors, []);
	assert.equal(view.open, false, "closing the selector closed its view");
	assert.equal(view.rows.size, 0);
	assert.ok(rows >= 80);
	view = undefined;
	assert.ok(
		sampled.filter(([name]) => name.startsWith("hook entry")).length >= 20,
		"the hook was handed the archived branch it abandons",
	);

	await settle();
	const retained = sampled.filter(([, ref]) => ref.deref() !== undefined).map(([name]) => name);
	assert.deepEqual(retained, [], `${retained.length}/${sampled.length} sampled objects outlived the selector`);
});
