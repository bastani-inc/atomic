import assert from "node:assert/strict";
import { test } from "vitest";
import {
	refuseIntercomScriptCall,
	scriptSendOutcome,
	scriptSessionEntry,
} from "../../packages/intercom/codemode-access.js";

test("scripts may call intercom list, status, pending and exact-target send (#5087)", () => {
	for (const action of ["list", "status", "pending"]) assert.equal(refuseIntercomScriptCall({ action }), undefined);
	for (const to of ["worker-web", "a1b2c3d4", "a1b2c3d4-1111-4222-8333-000000000001"])
		assert.equal(refuseIntercomScriptCall({ action: "send", to }), undefined, to);
	assert.equal(refuseIntercomScriptCall({ action: "send" }), undefined);
});

test("scripts may not call the model-only intercom actions (#5087)", () => {
	for (const action of ["ask", "reply", "join", "leave", "cancel", "groups", "bogus"]) {
		assert.equal(
			refuseIntercomScriptCall({ action }),
			`intercom "${action}" is model-only: call the intercom tool directly, not from a script. Scripts may call intercom only with "list", "status", "pending", "send"; call the intercom tool directly for anything else.`,
		);
	}
});

test("scripts may not send to patterns or answer asks with replyTo (#5087)", () => {
	for (const to of ["worker-*", " * ", "subagents:*", "subagents:run-1/*", "subagents:x"]) {
		assert.equal(
			refuseIntercomScriptCall({ action: "send", to }),
			`Scripts may send only to an exact target: a live session name, or a full session id or unique 8-hex prefix. "${to.trim()}" is a pattern; send to each recipient by its exact name, or call the intercom tool directly to send to a pattern.`,
		);
	}
	assert.match(
		refuseIntercomScriptCall({ action: "send", to: "worker-web", replyTo: "abcd1234" }) ?? "",
		/^A send with replyTo answers an ask, which is model-only: call the intercom tool directly, not from a script\. Scripts may call intercom only with/,
	);
	assert.equal(refuseIntercomScriptCall({ action: "list", to: "*", replyTo: "x" }), undefined);
});

test("script session entries report presence, groups and reply capability (#5087)", () => {
	const base = { id: "s-1", cwd: "/repo", model: "m", pid: 1, startedAt: 1, lastActivity: 1 };
	assert.deepEqual(scriptSessionEntry(base, "s-1"), {
		sessionId: "s-1",
		cwd: "/repo",
		state: "unknown",
		groups: ["default"],
		self: true,
	});
	assert.deepEqual(scriptSessionEntry({ ...base, status: "  " }, null), {
		sessionId: "s-1",
		cwd: "/repo",
		state: "unknown",
		groups: ["default"],
		self: false,
	});
	assert.deepEqual(
		scriptSessionEntry(
			{
				...base,
				name: "worker",
				status: "tool:bash · 3s",
				replyCapability: "terminal",
				groups: ["team", "default"],
			},
			"other",
		),
		{
			sessionId: "s-1",
			name: "worker",
			cwd: "/repo",
			state: "busy",
			activity: "tool:bash",
			groups: ["team", "default"],
			replyCapability: "terminal",
			self: false,
		},
	);
	assert.deepEqual(scriptSessionEntry({ ...base, name: "", status: "idle", group: "team" }, undefined), {
		sessionId: "s-1",
		cwd: "/repo",
		state: "idle",
		groups: ["team"],
		self: false,
	});
});

test("a script send resolves to its delivery outcome (#5087)", () => {
	const ok = (details: Record<string, unknown>) => ({ content: [{ text: "ok" }], isError: false, details });
	const failed = (details: Record<string, unknown>) => ({
		content: [{ text: "line one" }, { text: "line two" }],
		isError: true,
		details,
	});
	assert.deepEqual(scriptSendOutcome("w", ok({ messageId: "m1", delivered: true })), {
		action: "send",
		target: "w",
		messageId: "m1",
		outcome: "delivered",
	});
	assert.deepEqual(scriptSendOutcome("w", ok({ messageId: "m2", queued: true, delivered: false })), {
		action: "send",
		target: "w",
		messageId: "m2",
		outcome: "queued",
	});
	assert.deepEqual(scriptSendOutcome("w", ok({})), { action: "send", target: "w", outcome: "cancelled" });
	assert.deepEqual(scriptSendOutcome("w", failed({ error: true, outcome: "unknown" })), {
		action: "send",
		target: "w",
		outcome: "unknown",
		reason: "line one\nline two",
	});
	assert.deepEqual(scriptSendOutcome("w", failed({ messageId: 7, delivered: false, reason: "gone" })), {
		action: "send",
		target: "w",
		outcome: "refused",
		reason: "gone",
	});
});
