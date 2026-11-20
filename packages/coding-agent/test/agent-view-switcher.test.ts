import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { TaskId } from "../src/core/tasks/contracts.js";
import { AgentViewSwitcher } from "../src/modes/interactive/agent-view/agent-view-switcher.ts";
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
