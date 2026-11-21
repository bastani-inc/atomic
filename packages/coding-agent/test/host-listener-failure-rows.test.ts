import assert from "node:assert/strict";
import { Container, Text } from "@bastani/atomic-tui";
import { beforeAll, describe, test, vi } from "vitest";
import { collectEverythingTracked, trackCollection } from "../../../test/helpers/collect-garbage.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import type { ActivityWatchdogDiagnostic } from "../src/modes/interactive-engine/activity-watchdog.js";
import { renderEngineDiagnostic } from "../src/modes/interactive-engine/engine-diagnostic-view.js";
import { EngineHealthController } from "../src/modes/interactive-engine/engine-health.js";
import { HostListenerFailures } from "../src/modes/interactive-engine/host-listener-failures.js";
import { normalizeRenderedOutput } from "./interactive-mode-status-helpers.ts";

const update = { type: "message_update" };
const failing = (reason: string) => () => {
	throw new Error(reason);
};
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

/** The chat of an interactive mode, shown a host listener's failures as the interactive mode shows them. */
function chat() {
	const mode = { chatContainer: new Container(), ui: { requestRender: vi.fn() } };
	const prototype = InteractiveMode.prototype as unknown as {
		showError(this: typeof mode, message: string): void;
		showRepeatedError(this: typeof mode, message: string, series: object): void;
	};
	const failures = new HostListenerFailures((diagnostic) =>
		renderEngineDiagnostic(diagnostic, {
			stopWorkingLoader: () => {},
			showStatus: () => {},
			showError: (message) => prototype.showError.call(mode, message),
			showRepeatedError: (message, series) => prototype.showRepeatedError.call(mode, message, series),
		}),
	);
	return {
		failures,
		container: mode.chatContainer,
		/** Something else drawn in the chat: an assistant message, a tool call. */
		draw: (text: string) => mode.chatContainer.addChild(new Text(text, 0, 0)),
		clear: () => mode.chatContainer.clear(),
		errors: () =>
			normalizeRenderedOutput(mode.chatContainer)
				.split("\n")
				.filter((line) => line.includes("Error:") || line.startsWith("drawn"))
				.map((line) => line.trim()),
	};
}

/** Tracks each of `parts`, in a frame of its own: none stays referenced by the test's suspended frame. */
function trackEach(rows: ReturnType<typeof trackCollection>, parts: readonly object[]): void {
	for (const part of parts) rows.track(part);
}

const row = (reason: string, times?: number) =>
	`Error: Atomic failed while handling the interactive engine's "message_update" event: ${reason}${times === undefined ? "" : ` (${times} times)`}`;

describe("host listener failures in the chat", () => {
	beforeAll(() => initTheme("dark"));

	test("a listener that fails on every streamed update is one error row with a count", () => {
		const { failures, errors } = chat();
		const listener = failing("could not draw the update");

		for (let index = 0; index < 5; index++) failures.call(listener, update, "event");

		assert.deepEqual(errors(), [row("could not draw the update", 5)]);
	});

	test("a listener failing on two kinds of update in turn keeps a row for each", () => {
		const { failures, errors } = chat();
		const listener = failing("could not draw it");

		for (let index = 0; index < 4; index++) {
			failures.call(listener, update, "event");
			failures.call(listener, { type: "tool_execution_update" }, "event");
		}

		assert.deepEqual(errors(), [
			row("could not draw it", 4),
			`Error: Atomic failed while handling the interactive engine's "tool_execution_update" event: could not draw it (4 times)`,
		]);
	});

	test("two listeners failing in turn keep a row each; another reason starts its own row", () => {
		const { failures, errors } = chat();
		const first = failing("first failed");
		const second = failing("second failed");

		for (let index = 0; index < 3; index++) {
			failures.call(first, update, "event");
			failures.call(second, update, "event");
		}
		failures.call(failing("first failed differently"), update, "event");

		assert.deepEqual(errors(), [row("first failed", 3), row("second failed", 3), row("first failed differently")]);
	});

	test("a failure after something else was drawn is a new row at the bottom; so is one after the chat was cleared", () => {
		const { failures, draw, clear, errors } = chat();
		const listener = failing("could not draw the update");

		failures.call(listener, update, "event");
		failures.call(listener, update, "event");
		draw("drawn: the next answer");
		failures.call(listener, update, "event");

		assert.deepEqual(errors(), [
			row("could not draw the update", 2),
			"drawn: the next answer",
			row("could not draw the update"),
		]);
		clear();
		failures.call(listener, update, "event");
		assert.deepEqual(errors(), [row("could not draw the update")]);
	});

	test("rows the chat no longer shows are not kept for their listener's next failure", async () => {
		const { failures, clear, errors, container } = chat();
		const listeners = Array.from({ length: 8 }, (_, index) => failing(`listener ${index} failed`));
		const rows = trackCollection();
		for (const listener of listeners) failures.call(listener, update, "event");
		assert.equal(errors().length, 8);

		trackEach(rows, container.children);
		clear();
		await collectEverythingTracked(rows);

		assert.deepEqual(rows.uncollected(), []);
		assert.equal(listeners.length, 8, "the listeners are still registered");
	});

	test("rejections of a listener's promises are counted in its row, as its throws are", async () => {
		const { failures, errors } = chat();
		const listener = async () => {
			throw new Error("could not save the update");
		};

		for (let index = 0; index < 3; index++) failures.call(listener, update, "event");
		await nextTurn();

		assert.deepEqual(errors(), [row("could not save the update", 3)]);
	});

	test("a listener adapted to each call is counted as the listener the host registered", () => {
		const reported: ActivityWatchdogDiagnostic[] = [];
		const failures = new HostListenerFailures((diagnostic) => reported.push(diagnostic));
		const registered = failing("could not count the heartbeat");

		failures.call(() => registered(), update, "event", update, registered);
		failures.call(() => registered(), update, "event", update, registered);

		assert.equal(reported.length, 2);
		assert.ok(reported[0]?.series);
		assert.equal(reported[1]?.series, reported[0]?.series);
	});
});

describe("engine diagnostics listeners", () => {
	test("a listener that throws or rejects neither escapes nor keeps the diagnostic from the others", async () => {
		const unhandled: unknown[] = [];
		const record = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", record);
		try {
			const health = new EngineHealthController({
				stop: async () => {},
				restart: async () => {},
				clearActivity: () => {},
			});
			const diagnostic: ActivityWatchdogDiagnostic = {
				activity: undefined,
				elapsedMs: 0,
				level: "unresponsive",
				message: "Interactive engine emitted malformed JSONL",
			};
			// Published before any view listens: kept, then handed to the first one.
			health.publish(diagnostic);
			const seen: string[] = [];
			health.onDiagnostic(() => {
				throw new Error("the view could not show it");
			});
			health.onDiagnostic(async () => {
				throw new Error("the view could not show it");
			});
			health.onDiagnostic((received) => seen.push(received.message));

			health.publish(diagnostic);
			await nextTurn();

			assert.deepEqual(seen, ["Interactive engine emitted malformed JSONL"]);
			assert.deepEqual(unhandled, []);
		} finally {
			process.off("unhandledRejection", record);
		}
	});
});
