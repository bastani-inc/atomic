import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import { AgentTaskHost } from "../src/core/tasks/agent-adapter.ts";
import {
	ChildTaskWaits,
	childCommandRouteCount,
	createChildCommandTaskOwner,
} from "../src/core/tasks/child-command-owner.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const harnesses: Harness[] = [];
afterEach(async () => {
	while (harnesses.length > 0) await harnesses.pop()?.cleanup();
});

const route = { isOpen: () => true, deliver: async () => {} };

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

	test("a child closing after its parent's session closed has no route to drop and does not fail", () => {
		const owner = createChildCommandTaskOwner(() => {
			throw new Error("the parent's session is closed");
		});
		assert.doesNotThrow(() => owner.unbind("child-a"));
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
});
