import assert from "node:assert/strict";
import type { SubagentChildPolicy } from "@bastani/atomic";
import { test } from "vitest";
import { admitActiveSessionInbound } from "../../packages/intercom/active-session-admission.js";

const policy: SubagentChildPolicy = {
	managementActions: "restricted",
	fanoutAuthorized: false,
	inheritProjectContext: false,
	inheritSkills: false,
};

for (const idle of [true, false]) {
	test(`an ${idle ? "idle/preflight" : "active"} admitted child bypasses legacy refusal`, async () => {
		const ended = new AbortController();
		let deliveries = 0;
		const context = { subagentPolicy: { ...policy, executionEnded: ended.signal }, isIdle: () => idle };
		const result = admitActiveSessionInbound(context, () => {
			deliveries++;
		});
		assert.notEqual(result, false);
		await result;
		assert.equal(deliveries, 1);
		assert.equal(ended.signal.aborted, false);
	});
}

for (const kind of ["ordinary interactive", "unrelated headless", "policy-only host"] as const) {
	test(`${kind} retains its original idle/refusal routing`, () => {
		let deliveries = 0;
		const context = { ...(kind === "policy-only host" ? { subagentPolicy: policy } : {}), isIdle: () => false };
		assert.equal(
			admitActiveSessionInbound(context, () => {
				deliveries++;
			}),
			false,
		);
		assert.equal(deliveries, 0);
	});
}

for (const terminal of ["execution ended", "admission sealed"] as const) {
	test(`a child with ${terminal} rejects without delivery`, async () => {
		const ended = new AbortController();
		if (terminal === "execution ended") ended.abort();
		const context = {
			subagentPolicy: {
				...policy,
				executionEnded: ended.signal,
				messageAdmission: {
					isOpen: () => terminal !== "admission sealed",
					run: async (deliver: () => void | Promise<void>) => {
						await deliver();
					},
				},
			},
		};
		let deliveries = 0;
		const result = admitActiveSessionInbound(context, () => {
			deliveries++;
		});
		assert.notEqual(result, false);
		await assert.rejects(result as Promise<void>, /Subagent execution is terminal/);
		assert.equal(deliveries, 0);
	});
}
