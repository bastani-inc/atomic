import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionInfo, SessionListProgress } from "../src/core/session-manager.ts";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

async function flushPromises(times = 4): Promise<void> {
	for (let index = 0; index < times; index += 1) {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => { resolve = res; });
	return { promise, resolve };
}

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
	};
}

describe("session selector progressive loading", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("renders header/loading in the first frame before a blocked loader resolves, then shows rows", async () => {
		const gate = deferred<SessionInfo[]>();
		const requestRender = vi.fn();
		const keybindings = new KeybindingsManager();
		const selector = new SessionSelectorComponent(
			() => gate.promise,
			async () => [],
			() => {},
			() => {},
			() => {},
			requestRender,
			{ showRenameHint: false, keybindings },
		);

		// First frame: mounted and rendering while the loader is still pending.
		const firstFrame = selector.render(120).join("\n");
		expect(firstFrame.length).toBeGreaterThan(0);
		expect(firstFrame).not.toContain("first-loaded");
		// The host render loop was signalled during mount (loading is live).
		expect(requestRender).toHaveBeenCalled();

		gate.resolve([makeSession({ id: "loaded" })]);
		await flushPromises();

		const afterFrame = selector.render(120).join("\n");
		expect(afterFrame).toContain("first-loaded");
	});

	it("seeds initialSessions on the first frame while the loader is blocked", async () => {
		const gate = deferred<SessionInfo[]>();
		const keybindings = new KeybindingsManager();
		const selector = new SessionSelectorComponent(
			() => gate.promise,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{
				showRenameHint: false,
				keybindings,
				initialSessions: [makeSession({ id: "seed" })],
			},
		);

		const firstFrame = selector.render(120).join("\n");
		expect(firstFrame).toContain("first-seed");

		gate.resolve([]);
		await flushPromises();
	});

	it("stays interactive while loading: cancel is routed to onCancel during a blocked load", async () => {
		const gate = deferred<SessionInfo[]>();
		const onCancel = vi.fn();
		const keybindings = new KeybindingsManager();
		const selector = new SessionSelectorComponent(
			() => gate.promise,
			async () => [],
			() => {},
			onCancel,
			() => {},
			() => {},
			{ showRenameHint: false, keybindings },
		);

		// Escape while the loader is still pending must cancel the picker.
		selector.handleInput("\x1b");
		expect(onCancel).toHaveBeenCalledTimes(1);

		gate.resolve([]);
		await flushPromises();
	});

	it("ignores a loader that resolves after dispose (stale-result guard)", async () => {
		const gate = deferred<SessionInfo[]>();
		const keybindings = new KeybindingsManager();
		const selector = new SessionSelectorComponent(
			() => gate.promise,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ showRenameHint: false, keybindings },
		);

		selector.dispose();
		gate.resolve([makeSession({ id: "late" })]);
		await flushPromises();

		const frame = selector.render(120).join("\n");
		expect(frame).not.toContain("first-late");
	});

	it("reports progress from the loader while a large scan is in flight", async () => {
		let reportProgress: SessionListProgress | undefined;
		const gate = deferred<SessionInfo[]>();
		const keybindings = new KeybindingsManager();
		const requestRender = vi.fn();
		const selector = new SessionSelectorComponent(
			(onProgress) => {
				reportProgress = onProgress;
				return gate.promise;
			},
			async () => [],
			() => {},
			() => {},
			() => {},
			requestRender,
			{ showRenameHint: false, keybindings },
		);

		expect(reportProgress).toBeTypeOf("function");
		reportProgress?.(3, 10);
		// Progress mid-scan drives a render so the host shows a live heartbeat.
		expect(requestRender).toHaveBeenCalled();

		gate.resolve([makeSession({ id: "done" })]);
		await flushPromises();
		expect(selector.render(120).join("\n")).toContain("first-done");
	});
});
