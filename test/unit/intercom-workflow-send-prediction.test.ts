import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { SendResult } from "../../packages/intercom/broker/client.js";
import { queuedSendText, registerIntercomTool } from "../../packages/intercom/intercom-tool.js";
import { ReplyTracker } from "../../packages/intercom/reply-tracker.js";
import { ReplyWaiterRegistry } from "../../packages/intercom/reply-waiter.js";
import type { SessionInfo, WorkflowFutureStageRosterEntry } from "../../packages/intercom/types.js";
import {
	isWorkflowFutureStagePredictionFields,
	isWorkflowSendPredictionFields,
	workflowFutureStagePredictionFields,
	workflowSendPredictionFields,
} from "../../packages/intercom/workflow-prediction-fields.js";

const RUN_ID = "4ac72924-c452-4e5f-9e63-2435722109f7";
const TARGET = `workflow:${RUN_ID}/reviwe-1`;
const OLD_WARNING =
	"(not in the workflow's known stage set; it will be delivered to every matching stage that starts before the run terminates)";

type ToolResult = { content: Array<{ text: string }>; isError: boolean; details?: Record<string, unknown> };
type Tool = {
	execute(id: string, params: object, signal: undefined, update: undefined, ctx: object): Promise<ToolResult>;
};

const self: SessionInfo = {
	id: "self-session-id",
	name: "self",
	cwd: "/worktree",
	model: "test",
	pid: 1,
	startedAt: 1,
	lastActivity: 1,
	groups: [`workflow:${RUN_ID}`],
	group: `workflow:${RUN_ID}`,
};

function tool(
	sendResult: Partial<SendResult>,
	settings?: { readonly intercom?: { readonly showUnknownTargetWarnings?: boolean } },
	futureStages: readonly WorkflowFutureStageRosterEntry[] = [],
): Tool {
	let registered: Tool | undefined;
	const client = {
		sessionId: self.id,
		groups: self.groups,
		async listSessions(): Promise<SessionInfo[]> {
			return [self];
		},
		async listDirectory() {
			return { sessions: [self], workflowStages: [], workflowFutureStages: futureStages };
		},
		async send(): Promise<SendResult> {
			return { id: "message-id", delivered: false, queued: true, target: TARGET, position: 1, ...sendResult };
		},
	};
	const waiters = new ReplyWaiterRegistry();
	registerIntercomTool(
		{
			registerTool(value: Tool) {
				registered = value;
			},
			async appendEntry() {},
			...(settings === undefined ? {} : { getSettings: () => settings }),
		} as never,
		{
			ensureConnected: async () => client,
			syncPresenceIdentity() {},
			homeGroup: () => "default",
			setJoinedGroups() {},
			clearJoinedGroups() {},
			confirmSend: false,
			beginReplyWait: (from: string, replyTo: string, signal?: AbortSignal) => waiters.begin(from, replyTo, signal),
			replyTracker: new ReplyTracker(),
		} as never,
	);
	assert.ok(registered);
	return registered;
}

const context = { sessionManager: { getSessionId: () => "atomic-session" }, hasUI: false };

async function send(sendResult: Partial<SendResult>, settings?: Parameters<typeof tool>[1]) {
	return tool(sendResult, settings).execute(
		"send",
		{ action: "send", to: TARGET, message: "hello" },
		undefined,
		undefined,
		context,
	);
}

describe("queued workflow sends (#4359)", () => {
	test("a target outside the known set is a plain queued result with the classification in details", async () => {
		const result = await send({ prediction: "unknown" }, { intercom: {} });
		assert.equal(result.isError, false);
		assert.equal(result.content[0]?.text, `Message queued for ${TARGET}`);
		assert.equal(result.details?.prediction, "unknown");
		assert.equal(result.details?.unexpected, undefined);
		assert.equal(result.details?.suggestion, undefined);
		const withoutSettings = await send({ prediction: "unknown" });
		assert.equal(withoutSettings.content[0]?.text, `Message queued for ${TARGET}`);
	});

	test("known and predicted targets are plain queued results", async () => {
		for (const prediction of ["known", "predicted"] as const) {
			const result = await send({ prediction }, { intercom: { showUnknownTargetWarnings: true } });
			assert.equal(result.content[0]?.text, `Message queued for ${TARGET}`);
			assert.equal(result.details?.prediction, prediction);
		}
	});

	test("a likely typo gets one line naming the closest stage", async () => {
		const result = await send({ prediction: "unknown", unexpected: true, suggestion: "review-1" });
		assert.equal(
			result.content[0]?.text,
			`Message queued for ${TARGET}\nNo stage named reviwe-1 is expected; did you mean review-1?`,
		);
		assert.equal(result.details?.unexpected, true);
		assert.equal(result.details?.suggestion, "review-1");
		const unmatched = await send({ prediction: "unknown", unexpected: true });
		assert.equal(unmatched.content[0]?.text, `Message queued for ${TARGET}\nNo stage named reviwe-1 is expected.`);
	});

	test("intercom.showUnknownTargetWarnings restores the old warning for unknown targets", async () => {
		const result = await send({ prediction: "unknown" }, { intercom: { showUnknownTargetWarnings: true } });
		assert.equal(result.content[0]?.text, `Message queued for ${TARGET} ${OLD_WARNING}`);
		assert.equal(
			queuedSendText(TARGET, { prediction: "unknown" }, false),
			`Message queued for ${TARGET}`,
			"off by default",
		);
	});

	test("the typo line names a nested stage path, and details carry only the fields that are set", async () => {
		assert.equal(
			queuedSendText(`workflow:${RUN_ID}/workflow:child/reviwe`, { prediction: "unknown", unexpected: true }, false),
			`Message queued for workflow:${RUN_ID}/workflow:child/reviwe\nNo stage named workflow:child/reviwe is expected.`,
		);
		const plain = await send({});
		assert.deepEqual(plain.details, {
			messageId: "message-id",
			delivered: false,
			queued: true,
			target: TARGET,
			position: 1,
		});
		const typo = await send({ prediction: "unknown", unexpected: true, suggestion: "review-1" });
		assert.deepEqual(typo.details, {
			messageId: "message-id",
			delivered: false,
			queued: true,
			target: TARGET,
			position: 1,
			prediction: "unknown",
			unexpected: true,
			suggestion: "review-1",
		});
	});

	test("settings without an intercom section leave the default plain result", async () => {
		const result = await send({ prediction: "unknown" }, {});
		assert.equal(result.content[0]?.text, `Message queued for ${TARGET}`);
	});

	test("a non-workflow target keeps its name in the typo line", () => {
		assert.equal(
			queuedSendText("peer", { unexpected: true, suggestion: "pear" }, false),
			"Message queued for peer\nNo stage named peer is expected; did you mean pear?",
		);
	});

	test("intercom list labels predicted, confirmed and unused rows", async () => {
		const row = (target: string, extra: Partial<WorkflowFutureStageRosterEntry>): WorkflowFutureStageRosterEntry => ({
			kind: "workflow-future-stage",
			runId: RUN_ID,
			target: `workflow:${RUN_ID}/${target}`,
			queuedCount: 0,
			group: `workflow:${RUN_ID}`,
			...extra,
		});
		const listed = await tool({}, undefined, [
			row("review-1", { prediction: "predicted", probability: 0.925 }),
			row("lint", { prediction: "confirmed", probability: 0.99, queuedCount: 1 }),
			row("workflow:child-beta", { prediction: "unused", probability: 0.81 }),
			row("summary-*", {}),
			row("lint-*", { prediction: "predicted" }),
		]).execute("list", { action: "list" }, undefined, undefined, context);
		const text = listed.content[0]?.text ?? "";
		assert.match(
			text,
			new RegExp(`- \`workflow:${RUN_ID}/review-1\` \\[future, predicted 0\\.93\\] 0 queued messages\\n`),
		);
		assert.match(text, new RegExp(`- \`workflow:${RUN_ID}/lint\` \\[future, confirmed\\] 1 queued message\\n`));
		assert.match(
			text,
			new RegExp(`- \`workflow:${RUN_ID}/workflow:child-beta\` \\[future, unused\\] 0 queued messages\\n`),
		);
		assert.match(text, new RegExp(`- \`workflow:${RUN_ID}/summary-\\*\` \\[future\\] 0 queued messages`));
		assert.match(text, new RegExp(`- \`workflow:${RUN_ID}/lint-\\*\` \\[future, predicted\\] 0 queued messages`));
	});
});

describe("workflow prediction wire fields (#4359)", () => {
	test("send classifications are validated and copied field by field", () => {
		for (const valid of [
			{},
			{ prediction: "known" },
			{ prediction: "predicted" },
			{ prediction: "unknown", unexpected: true, suggestion: "review-1" },
			{ suggestion: "x".repeat(512) },
		]) {
			assert.equal(isWorkflowSendPredictionFields(valid), true, JSON.stringify(valid));
		}
		for (const invalid of [
			{ prediction: "maybe" },
			{ prediction: true },
			{ unexpected: false },
			{ suggestion: "" },
			{ suggestion: 7 },
			{ suggestion: "x".repeat(513) },
			{ suggestion: ["x"] },
		]) {
			assert.equal(isWorkflowSendPredictionFields(invalid), false, JSON.stringify(invalid));
		}
		assert.deepEqual(
			workflowSendPredictionFields({
				type: "queued",
				prediction: "unknown",
				unexpected: true,
				suggestion: "review-1",
				extra: 1,
			}),
			{ prediction: "unknown", unexpected: true, suggestion: "review-1" },
		);
		assert.deepEqual(workflowSendPredictionFields({ prediction: "maybe", unexpected: false }), {});
	});

	test("possible-stage row predictions are validated", () => {
		for (const valid of [
			{},
			{ prediction: "predicted", probability: 0 },
			{ prediction: "unused", probability: 1 },
			{ prediction: "confirmed" },
		]) {
			assert.equal(isWorkflowFutureStagePredictionFields(valid), true, JSON.stringify(valid));
		}
		for (const invalid of [
			{ prediction: "known" },
			{ probability: 1.01 },
			{ probability: -0.01 },
			{ probability: Number.NaN },
			{ probability: "0.9" },
			{ probability: Number.POSITIVE_INFINITY },
		]) {
			assert.equal(isWorkflowFutureStagePredictionFields(invalid), false, JSON.stringify(invalid));
		}
	});

	test("a roster entry copies only the prediction fields a row sets", () => {
		assert.deepEqual(workflowFutureStagePredictionFields({}), {});
		assert.deepEqual(workflowFutureStagePredictionFields({ prediction: "confirmed" }), { prediction: "confirmed" });
		assert.deepEqual(workflowFutureStagePredictionFields({ probability: 0.5 }), { probability: 0.5 });
		assert.deepEqual(
			workflowFutureStagePredictionFields({ prediction: "unused", probability: 0.81, target: "x" } as never),
			{ prediction: "unused", probability: 0.81 },
		);
	});
});
