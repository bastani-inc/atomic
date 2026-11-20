import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { TaskId } from "../src/core/tasks/contracts.js";
import { AgentViewSwitcher, NOT_SHOWN } from "../src/modes/interactive/agent-view/agent-view-switcher.ts";
import type { AgentViewChange, AgentViewPort } from "../src/modes/interactive/agent-view/contracts.ts";
import { FakeAgentViewPort } from "./helpers/fake-agent-view-port.ts";

const id = (value: string) => value as TaskId;

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function shownName(switcher: AgentViewSwitcher): string {
	const viewed = switcher.viewed;
	return viewed.kind === "main" ? "main" : viewed.port.status().name;
}

describe("the single chat screen's switcher", () => {
	test("shows the subagent asked for last, and releases one opened for an earlier request", async () => {
		const slow = deferred<AgentViewPort | undefined>();
		const first = new FakeAgentViewPort({ taskId: id("a"), name: "first" });
		const second = new FakeAgentViewPort({ taskId: id("b"), name: "second" });
		const switcher = new AgentViewSwitcher(
			(taskId) => (taskId === id("a") ? slow.promise : Promise.resolve(second)),
			() => {},
		);

		const earlier = switcher.view(id("a"));
		assert.equal(await switcher.view(id("b")), true);
		slow.resolve(first);
		assert.equal(await earlier, false);

		assert.equal(shownName(switcher), "second");
		assert.equal(first.disposed, true);
		assert.equal(second.disposed, false);
	});

	test("gives the screen back to main in the same tick when the shown subagent is gone", async () => {
		const port = new FakeAgentViewPort({ taskId: id("a") });
		const switcher = new AgentViewSwitcher(
			async () => port,
			() => {},
		);
		const changes: string[] = [];
		switcher.onChange(({ from, to }) => changes.push(`${from.kind}->${to.kind}`));
		await switcher.view(id("a"));

		port.setStatus({ gone: true });

		assert.equal(switcher.viewed.kind, "main");
		assert.deepEqual(changes, ["main->agent", "agent->main"]);
		assert.equal(port.disposed, true);
	});

	test("releases the port it leaves only after every listener ran, so one can keep it", async () => {
		const port = new FakeAgentViewPort({ taskId: id("a") });
		const switcher = new AgentViewSwitcher(
			async () => port,
			() => {},
		);
		let kept: (() => void) | undefined;
		switcher.onChange((change: AgentViewChange) => {
			if (change.from.kind === "agent") kept = change.from.port.retain();
		});
		await switcher.view(id("a"));

		await switcher.view(undefined);
		assert.equal(port.disposed, false);
		kept?.();
		assert.equal(port.disposed, true);
	});

	test("marks the subagent being opened as pending from the request until it is shown, whichever request ends first", async () => {
		const slow = deferred<AgentViewPort | undefined>();
		const fast = deferred<AgentViewPort | undefined>();
		const first = new FakeAgentViewPort({ taskId: id("a") });
		const second = new FakeAgentViewPort({ taskId: id("b") });
		const switcher = new AgentViewSwitcher(
			(taskId) => (taskId === id("a") ? slow.promise : fast.promise),
			() => {},
		);
		const seen: (string | undefined)[] = [];
		switcher.onPending((pending) => seen.push(pending));

		const earlier = switcher.view(id("a"));
		assert.equal(switcher.pendingTaskId, id("a"));
		const later = switcher.view(id("b"));
		assert.equal(switcher.pendingTaskId, id("b"));
		slow.resolve(first);
		await earlier;
		assert.equal(switcher.pendingTaskId, id("b"));
		fast.resolve(second);
		await later;

		assert.equal(switcher.pendingTaskId, undefined);
		assert.deepEqual(seen, ["a", "b", undefined]);
	});

	test("still shows a subagent being opened when the one shown is gone meanwhile", async () => {
		const opening = deferred<AgentViewPort | undefined>();
		const shown = new FakeAgentViewPort({ taskId: id("a"), name: "first" });
		const next = new FakeAgentViewPort({ taskId: id("b"), name: "second" });
		const switcher = new AgentViewSwitcher(
			(taskId) => (taskId === id("a") ? Promise.resolve(shown) : opening.promise),
			() => {},
		);
		await switcher.view(id("a"));

		const request = switcher.view(id("b"));
		shown.setStatus({ gone: true });
		assert.equal(switcher.viewed.kind, "main");
		opening.resolve(next);

		assert.equal(await request, true);
		assert.equal(shownName(switcher), "second");
		assert.equal(switcher.pendingTaskId, undefined);
	});

	test("tells the reader when the subagent asked for cannot be shown, and keeps what the screen shows", async () => {
		const gone = new FakeAgentViewPort({ taskId: id("b"), gone: true });
		const notices: string[] = [];
		const switcher = new AgentViewSwitcher(
			async (taskId) => (taskId === id("b") ? gone : undefined),
			(message) => notices.push(message),
		);

		assert.equal(await switcher.view(id("a")), false);
		assert.equal(await switcher.view(id("b")), false);

		assert.equal(switcher.viewed.kind, "main");
		assert.equal(switcher.pendingTaskId, undefined);
		assert.deepEqual(notices, [NOT_SHOWN, NOT_SHOWN]);
		assert.equal(gone.disposed, true);
	});

	test("keeps the shown port when another attempt of the same subagent is asked for", async () => {
		const shown = new FakeAgentViewPort({ taskId: id("a1"), agentKey: "a" });
		const again = new FakeAgentViewPort({ taskId: id("a2"), agentKey: "a" });
		const switcher = new AgentViewSwitcher(
			async (taskId) => (taskId === id("a1") ? shown : again),
			() => {},
		);
		const changes: AgentViewChange[] = [];
		switcher.onChange((change) => changes.push(change));
		await switcher.view(id("a1"));

		assert.equal(await switcher.view(id("a2")), true);

		assert.equal(changes.length, 1);
		assert.equal(switcher.viewed.kind === "agent" && switcher.viewed.port, shown);
		assert.equal(again.disposed, true);
	});
});
