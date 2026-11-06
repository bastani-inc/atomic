import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionInternalSurface } from "../src/core/agent-session-methods.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { AgentTaskHost } from "../src/core/tasks/agent-adapter.ts";
import {
	type ChildCommandTaskOwner,
	ChildTaskWaits,
	childCommandRouteCount,
	childTaskCompletionRoute,
	createChildCommandTaskOwner,
} from "../src/core/tasks/child-command-owner.ts";
import type { TaskId } from "../src/core/tasks/contracts.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const harnesses: Harness[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	while (cleanups.length > 0) await cleanups.pop()?.();
});

const route = { isOpen: () => true, deliver: async () => {} };

async function parentSession(): Promise<{ session: AgentSession; owner: ChildCommandTaskOwner }> {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-child-command-owner-"));
	const { session } = await createAgentSession({
		cwd,
		agentDir: join(cwd, "agent"),
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory(),
		builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
	});
	cleanups.push(async () => {
		await session.dispose();
		rmSync(cwd, { recursive: true, force: true });
	});
	const owner = (session as unknown as AgentSessionInternalSurface)._childSessionOptions?.({}).parentCommandTaskOwner;
	assert.ok(owner);
	return { session, owner };
}

describe("a child's completion route in its parent's command owner (#4326)", () => {
	test("is held from bind until unbind, and unbinding a child nobody bound is harmless", () => {
		const host = new AgentTaskHost({ scope: { kind: "session", sessionId: "owner" }, authorizeLaunch() {} });
		const owner = createChildCommandTaskOwner(() => host);
		owner.unbind("before-any-bind");
		assert.equal(childCommandRouteCount(host), 0);
		owner.bind("child-a", route, new ChildTaskWaits());
		owner.bind("child-b", route, new ChildTaskWaits());
		owner.bind("child-a", route, new ChildTaskWaits());
		assert.equal(childCommandRouteCount(host), 2, "a child's second bind replaces its route");
		owner.unbind("child-a");
		owner.unbind("never-bound");
		assert.equal(childCommandRouteCount(host), 1);
		owner.unbind("child-b");
		assert.equal(childCommandRouteCount(host), 0);
	});

	test("a child closing after its parent's session closed has no route to drop and does not fail (#4326)", async () => {
		const { session, owner } = await parentSession();
		owner.bind("child-a", route, new ChildTaskWaits());
		const host = session.getAgentTaskHost();
		assert.equal(childCommandRouteCount(host), 1);
		await session.dispose();

		assert.throws(() => session.getAgentTaskHost());
		assert.doesNotThrow(() => owner.unbind("child-a"));
		assert.equal(childCommandRouteCount(host), 0, "the route left the owner it was bound to");
		assert.throws(() => owner.bind("child-b", route, new ChildTaskWaits()));
	});

	test("a live parent drops the child's route on unbind (#4326)", async () => {
		const { session, owner } = await parentSession();
		owner.bind("child-a", route, new ChildTaskWaits());
		owner.unbind("child-a");
		assert.equal(childCommandRouteCount(session.getAgentTaskHost()), 0);
	});

	test("a child's route follows its parent to a new owner and is dropped from the last one without asking the parent (#4326)", () => {
		const first = new AgentTaskHost({ scope: { kind: "session", sessionId: "owner-1" }, authorizeLaunch() {} });
		const second = new AgentTaskHost({ scope: { kind: "session", sessionId: "owner-2" }, authorizeLaunch() {} });
		cleanups.push(() => void first.close("session-close"));
		cleanups.push(() => void second.close("session-close"));
		let current = first;
		let resolved = 0;
		const owner = createChildCommandTaskOwner(() => {
			resolved += 1;
			return current;
		});
		owner.bind("child-a", route, new ChildTaskWaits());
		current = second;
		owner.bind("child-a", route, new ChildTaskWaits());
		assert.deepEqual([childCommandRouteCount(first), childCommandRouteCount(second)], [0, 1]);

		owner.unbind("child-a");
		owner.unbind("child-a");

		assert.deepEqual([childCommandRouteCount(first), childCommandRouteCount(second)], [0, 0]);
		assert.equal(resolved, 2, "only binding looks the parent's owner up");
	});

	test("is dropped when the child's session closes, so a released child holds nothing in its parent", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const unbound: string[] = [];
		(harness.session as unknown as { _parentCommandTaskOwner: object })._parentCommandTaskOwner = {
			bind() {},
			unbind: (childId: string) => unbound.push(childId),
		};
		await harness.session.dispose();
		assert.deepEqual(unbound, [harness.session.sessionId]);
	});

	test("a released child keeps a route only while a shell task it launched runs, and loses it with the last one (#4326)", async () => {
		const host = new AgentTaskHost({ scope: { kind: "session", sessionId: "owner" }, authorizeLaunch() {} });
		cleanups.push(() => void host.close("session-close"));
		const owner = createChildCommandTaskOwner(() => host);
		const binding = owner.bind("child-a", route, new ChildTaskWaits());
		binding.onCommandStarted?.("t-1" as TaskId);
		binding.onCommandStarted?.("t-2" as TaskId);
		owner.bind("child-b", route, new ChildTaskWaits());
		owner.unbind("child-a");
		owner.unbind("child-b");
		const delivered: string[] = [];
		const released = {
			isOpen: () => true,
			deliver: async (message: { content: string }) => void delivered.push(message.content),
		};

		assert.equal(owner.routeReleased("child-b", released), false, "a child with nothing running keeps nothing");
		assert.equal(owner.routeReleased("child-a", released), true);
		assert.equal(childCommandRouteCount(host), 1);
		const message = (content: string) => ({
			customType: "task_completion",
			content,
			details: {},
			display: true as const,
		});
		await childTaskCompletionRoute(host, "t-1" as TaskId)?.deliver(message("first done"));
		assert.equal(childCommandRouteCount(host), 1, "one of its tasks still runs");
		await childTaskCompletionRoute(host, "t-2" as TaskId)?.deliver(message("second done"));

		assert.deepEqual(delivered, ["first done", "second done"]);
		assert.equal(childCommandRouteCount(host), 0);
		assert.equal(childTaskCompletionRoute(host, "t-2" as TaskId), undefined);
	});
});
