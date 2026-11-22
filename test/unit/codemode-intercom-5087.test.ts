import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { afterEach, test } from "vitest";
import type { ExtensionAPI } from "../../packages/coding-agent/src/core/extensions/index.js";
import { markTrustedMandatoryRuntimeExtension } from "../../packages/coding-agent/src/core/mandatory-runtime-tools.js";
import { createCodemodeExtension } from "../../packages/coding-agent/src/extensions/codemode/index.js";
import { createHarness, getMessageText, type Harness } from "../../packages/coding-agent/test/suite/harness.js";
import { createTestExtensionsResult, createTestResourceLoader } from "../../packages/coding-agent/test/utilities.js";
import { registerIntercomTool } from "../../packages/intercom/intercom-tool.js";
import { ReplyTracker } from "../../packages/intercom/reply-tracker.js";
import { ReplyWaiterRegistry } from "../../packages/intercom/reply-waiter.js";
import type { SessionInfo } from "../../packages/intercom/types.js";

const SELF_ID = "5e1f0000-0000-4000-8000-000000000000";

function peer(id: string, name: string, cwd: string, status = "idle"): SessionInfo {
	return { id, name, cwd, model: "test", pid: 1, startedAt: 1, lastActivity: 1, status, groups: ["default"] };
}

const sessions: SessionInfo[] = [
	peer(SELF_ID, "orchestrator", "/repo"),
	peer("a1b2c3d4-1111-4222-8333-000000000001", "worker-api", "/repo/api", "tool:bash"),
	peer("b2c3d4e5-1111-4222-8333-000000000002", "worker-web", "/repo/web"),
	peer("c3d4e5f6-1111-4222-8333-000000000003", "reviewer", "/repo/api"),
];

const WORKER_WEB = {
	sessionId: "b2c3d4e5-1111-4222-8333-000000000002",
	name: "worker-web",
	cwd: "/repo/web",
	state: "idle",
	groups: ["default"],
	self: false,
};

const harnesses: Harness[] = [];
const roots: string[] = [];
afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.cleanup();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function intercomHarness() {
	const replyTracker = new ReplyTracker();
	const sent: { to: string; text: string }[] = [];
	const client = {
		sessionId: SELF_ID,
		groups: ["default"],
		listSessions: async () => sessions,
		async send(to: string, message: { messageId?: string; text: string }) {
			if (to === "c3d4e5f6-1111-4222-8333-000000000003")
				return { id: message.messageId ?? "m", delivered: false, reason: "Session is shutting down" };
			sent.push({ to, text: message.text });
			return { id: message.messageId ?? "m", delivered: true };
		},
	};
	const waiters = new ReplyWaiterRegistry();
	const tempDir = mkdtempSync(join(tmpdir(), "codemode-intercom-"));
	roots.push(tempDir);
	const extensionsResult = await createTestExtensionsResult(
		[
			createCodemodeExtension(),
			(atomic: ExtensionAPI) =>
				registerIntercomTool(
					atomic as never,
					{
						ensureConnected: async () => client,
						syncPresenceIdentity() {},
						confirmSend: false,
						beginReplyWait: (from: string, replyTo: string, signal?: AbortSignal) =>
							waiters.begin(from, replyTo, signal),
						replyTracker,
						homeGroup: () => "default",
						setJoinedGroups() {},
						clearJoinedGroups() {},
					} as never,
				),
		],
		tempDir,
	);
	// Only the bundled Intercom package may register a tool named `intercom`.
	markTrustedMandatoryRuntimeExtension(extensionsResult.extensions[1]!);
	const harness = await createHarness({
		resourceLoader: createTestResourceLoader({ extensionsResult }),
		initialActiveToolNames: ["read", "codemode", "intercom"],
	});
	harnesses.push(harness);
	return { harness, sent, replyTracker };
}

async function runScript(harness: Harness, code: string): Promise<{ isError: boolean; text: string }> {
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("run the script");
	const result = harness.session.messages.findLast((message) => message.role === "toolResult");
	assert(result?.role === "toolResult");
	return { isError: result.isError, text: getMessageText(result) };
}

function lastJson(text: string): unknown {
	return JSON.parse(text.split("\n").at(-1) ?? "");
}

test("a codemode script lists intercom sessions and filters them by cwd (#5087)", async () => {
	const { harness } = await intercomHarness();
	const result = await runScript(
		harness,
		'const listed = await tools.intercom({ action: "list" }); return [listed.action, listed.groups, Object.keys(listed), listed.sessions.find((session) => session.self), listed.sessions.filter((session) => session.cwd === "/repo/api")];',
	);
	assert.equal(result.isError, false, result.text);
	const [action, groups, keys, self, filtered] = lastJson(result.text) as unknown[];
	assert.equal(action, "list");
	assert.deepEqual(groups, ["default"]);
	assert.deepEqual(keys, ["action", "groups", "sessions"]);
	assert.deepEqual(self, {
		sessionId: SELF_ID,
		name: "orchestrator",
		cwd: "/repo",
		state: "idle",
		groups: ["default"],
		self: true,
	});
	assert.deepEqual(filtered, [
		{
			sessionId: "a1b2c3d4-1111-4222-8333-000000000001",
			name: "worker-api",
			cwd: "/repo/api",
			state: "busy",
			activity: "tool:bash",
			groups: ["default"],
			self: false,
		},
		{
			sessionId: "c3d4e5f6-1111-4222-8333-000000000003",
			name: "reviewer",
			cwd: "/repo/api",
			state: "idle",
			groups: ["default"],
			self: false,
		},
	]);
});

test("a codemode script reads intercom status and pending asks as structured values (#5087)", async () => {
	const { harness, replyTracker } = await intercomHarness();
	const empty = await runScript(harness, 'return await tools.intercom({ action: "pending" });');
	assert.deepEqual(lastJson(empty.text), { action: "pending", inbound: [], outbound: [] });
	replyTracker.recordIncomingMessage(
		sessions[2]!,
		{ id: "ask-1", timestamp: 1, expectsReply: true, content: { text: "Which branch?" } },
		42,
	);
	const result = await runScript(
		harness,
		'const status = await tools.intercom({ action: "status" }); const pending = await tools.intercom({ action: "pending" }); const peek = await tools.intercom({ action: "list", group: "team" }); return { status: [status.action, status.sessionId, status.groups, status.sessions[2], status.outboundAsks], pending, peek: [peek.action, peek.peekGroup, peek.groups, peek.sessions[3]] };',
	);
	assert.equal(result.isError, false, result.text);
	assert.deepEqual(lastJson(result.text), {
		status: ["status", SELF_ID, ["default"], WORKER_WEB, 0],
		pending: {
			action: "pending",
			inbound: [
				{
					messageId: "ask-1",
					from: "worker-web",
					fromSessionId: "b2c3d4e5-1111-4222-8333-000000000002",
					receivedAt: 42,
					text: "Which branch?",
				},
			],
			outbound: [],
		},
		peek: [
			"list",
			"team",
			["default"],
			{
				sessionId: "c3d4e5f6-1111-4222-8333-000000000003",
				name: "reviewer",
				cwd: "/repo/api",
				state: "idle",
				groups: ["default"],
				self: false,
			},
		],
	});
});

test("a codemode script sends to two exact targets and gets one structured outcome each (#5087)", async () => {
	const { harness, sent } = await intercomHarness();
	const result = await runScript(
		harness,
		'return await Promise.all(["worker-web", "c3d4e5f6"].map((to) => tools.intercom({ action: "send", to, message: "rebase on main" })));',
	);
	assert.equal(result.isError, false, result.text);
	const outcomes = lastJson(result.text) as { target: string; outcome: string; reason?: string; messageId?: string }[];
	assert.deepEqual(
		outcomes.map(({ target, outcome, reason }) => ({ target, outcome, reason })),
		[
			{ target: "worker-web", outcome: "delivered", reason: undefined },
			{ target: "c3d4e5f6", outcome: "refused", reason: "Session is shutting down" },
		],
	);
	assert.equal(typeof outcomes[0]?.messageId, "string");
	assert.deepEqual(sent, [{ to: "b2c3d4e5-1111-4222-8333-000000000002", text: "rebase on main" }]);
});

test("codemode refuses intercom sends to globs and subagents (#5087)", async () => {
	const { harness, sent } = await intercomHarness();
	const result = await runScript(
		harness,
		'return await Promise.all(["worker-*", "*", "subagents:*"].map((to) => tools.intercom({ action: "send", to, message: "hi" }).then(() => "sent", (error) => error.message)));',
	);
	assert.equal(result.isError, false, result.text);
	const errors = lastJson(result.text) as string[];
	assert.equal(errors.length, 3);
	for (const error of errors) assert.match(error, /Scripts may send only to an exact target/);
	assert.deepEqual(sent, []);
});

test("codemode refuses intercom ask, reply and join with a pointer to the direct tool (#5087)", async () => {
	const { harness, sent } = await intercomHarness();
	const result = await runScript(
		harness,
		'return await Promise.all([{ action: "ask", to: "worker-web", message: "?" }, { action: "reply", message: "yes" }, { action: "join", group: "team" }, { action: "send", to: "worker-web", message: "yes", replyTo: "abcd1234" }].map((args) => tools.intercom(args).then(() => "ran", (error) => error.message)));',
	);
	assert.equal(result.isError, false, result.text);
	const errors = lastJson(result.text) as string[];
	assert.match(errors[0] ?? "", /intercom "ask" is model-only: call the intercom tool directly/);
	assert.match(errors[1] ?? "", /intercom "reply" is model-only: call the intercom tool directly/);
	assert.match(errors[2] ?? "", /intercom "join" is model-only: call the intercom tool directly/);
	assert.match(errors[3] ?? "", /replyTo answers an ask, which is model-only/);
	assert.deepEqual(sent, []);
});

test("a codemode send without a target rejects instead of resolving an outcome (#5087)", async () => {
	const { harness, sent } = await intercomHarness();
	const result = await runScript(
		harness,
		'return await tools.intercom({ action: "send", message: "hi" }).then((value) => value, (error) => error.message);',
	);
	assert.equal(result.text.split("\n").at(-1), "Missing 'to' or 'message' parameter");
	assert.deepEqual(sent, []);
});

test("codemode cannot call intercom while it is inactive (#5087)", async () => {
	const { harness } = await intercomHarness();
	harness.session.setActiveToolsByName(["read", "codemode"]);
	const result = await runScript(harness, 'return "intercom" in tools;');
	assert.equal(lastJson(result.text), false);
});

test("codemode describes the intercom script subset instead of a model-only hint (#5087)", async () => {
	const { harness } = await intercomHarness();
	const result = await runScript(
		harness,
		'return { described: await describeTool("intercom"), first: (await searchTools("intercom"))[0].description, listed: ALL_TOOLS.some((tool) => tool.name === "intercom") };',
	);
	assert.equal(result.isError, false, result.text);
	const output = lastJson(result.text) as { described: string; first: string; listed: boolean };
	assert.match(output.described, /the others \(ask, reply, cancel, join, leave, groups\) are model-only/);
	assert.doesNotMatch(output.first, /is model-only: call it directly/);
	assert.equal(output.listed, true);
	const declared = harness.session.agent.state.tools.find((tool) => tool.name === "intercom");
	assert.match(declared?.description ?? "", /^Send a message to another local agent session/);
	assert.doesNotMatch(declared?.description ?? "", /Codemode:/);
});

test("a direct intercom call still sends to a glob (#5087)", async () => {
	const { harness, sent } = await intercomHarness();
	harness.setResponses([
		fauxAssistantMessage(
			[fauxToolCall("intercom", { action: "send", to: "worker-*", message: "status?", broadcast: true })],
			{
				stopReason: "toolUse",
			},
		),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("ask the workers");
	const result = harness.session.messages.findLast((message) => message.role === "toolResult");
	assert(result?.role === "toolResult" && !result.isError, getMessageText(result));
	assert.match(getMessageText(result), /Message to `worker-\*` reached 2 of 2 recipients/);
	assert.deepEqual(
		sent.map(({ to }) => to),
		["a1b2c3d4-1111-4222-8333-000000000001", "b2c3d4e5-1111-4222-8333-000000000002"],
	);
});
