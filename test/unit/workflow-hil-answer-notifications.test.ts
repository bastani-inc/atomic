import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	HIL_ANSWER_NOTICE_CUSTOM_TYPE,
	installWorkflowHilAnswerNotifications,
	registerHilAnswerNoticeRenderer,
	type WorkflowHilAnswerNoticeDetails,
} from "../../packages/workflows/src/extension/hil-answer-notifications.js";
import { buildStagePromptAdapter } from "../../packages/workflows/src/shared/stage-prompt.js";
import { type StageCustomUiRequest, StageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { PendingPrompt, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { assertNoRawControls } from "../helpers/terminal-controls.js";

interface SentMessage {
	readonly customType: string;
	readonly content?: string;
	readonly display?: boolean;
	readonly details?: WorkflowHilAnswerNoticeDetails;
}

interface CardComponent {
	render(width: number): string[];
}

interface RegisteredRenderer {
	readonly event: string;
	readonly renderer: (payload: unknown) => unknown;
}

type SendOptions = {
	readonly triggerTurn?: boolean;
	readonly deliverAs?: "steer" | "followUp" | "nextTurn" | "interrupt";
	readonly excludeFromContext?: boolean;
	readonly interruptAbortMessage?: string;
};

const COLOR_ARGS = {
	questions: [
		{
			question: "What color?",
			options: [{ label: "Red" }, { label: "Blue" }],
		},
	],
};

function runningStage(overrides: Partial<StageSnapshot> = {}): StageSnapshot {
	return {
		id: "stage-1",
		name: "review",
		status: "running",
		parentIds: [],
		toolEvents: [],
		...overrides,
	};
}

function pendingPrompt(overrides: Partial<PendingPrompt> = {}): PendingPrompt {
	return {
		id: "prompt-1",
		kind: "input",
		message: "Secret passphrase?",
		createdAt: 10,
		...overrides,
	};
}

function setup() {
	const store = createStore();
	const broker = new StageUiBroker(store);
	const sent: SentMessage[] = [];
	const options: SendOptions[] = [];
	const registered: RegisteredRenderer[] = [];
	const unsubscribe = installWorkflowHilAnswerNotifications({
		store,
		stageUiBroker: broker,
		registerMessageRenderer(event, renderer) {
			registered.push({ event, renderer: renderer as (payload: unknown) => unknown });
		},
		sendMessage(message, sendOptions) {
			sent.push(message as SentMessage);
			options.push(sendOptions ?? {});
		},
	});
	store.recordRunStart({ id: "run-1", name: "release", inputs: {}, status: "running", stages: [], startedAt: 1 });
	store.recordStageStart("run-1", runningStage());
	return { store, broker, sent, options, registered, unsubscribe };
}

describe("installWorkflowHilAnswerNotifications", () => {
	// PR #2700: live HIL ANSWERED output changed the title and cleared the terminal.
	test("escapes notice display fields and narrow fallback without changing stored prompt, answer or details", () => {
		const { store, sent, options, registered, unsubscribe } = setup();
		const hostile = "Ω日本語\x1b]0;TITLE\x07\x1b]2;ST\x1b\\\x1b[2J\x9b2J\x08\x00\x7f\x90DCS\x9c";
		const runId = `run-${hostile}`;
		const stageId = `stage-${hostile}`;
		const prompt = pendingPrompt({ id: `prompt-${hostile}`, message: `Question ${hostile}` });
		const answer = `Answer ${hostile}`;
		store.recordRunStart({
			id: runId,
			name: `Workflow ${hostile}`,
			inputs: {},
			status: "running",
			stages: [],
			startedAt: 1,
		});
		store.recordStageStart(runId, runningStage({ id: stageId, name: `Stage ${hostile}` }));
		try {
			assert.equal(store.recordStagePendingPrompt(runId, stageId, prompt), true);
			assert.equal(store.resolveStagePendingPrompt(runId, stageId, prompt.id, answer), true);
			assert.equal(sent.length, 1);
			assert.deepEqual(options[0], { triggerTurn: false, excludeFromContext: true });
			const message = sent[0]!;
			const originalDetails = structuredClone(message.details);
			assert.equal(message.details?.promptMessage, prompt.message);
			assert.equal(message.details?.answerSummary, answer);
			assert.equal(store.getStagePromptAnswer(runId, stageId)?.value, answer);
			assert.equal(
				store.runs().find((run) => run.id === runId)?.stages[0]?.promptFootprint?.message,
				prompt.message,
			);
			const component = registered[0]!.renderer(message) as CardComponent;
			for (const width of [160, 80, 32, 24, 1]) {
				const output = component.render(width).join("\n");
				assertNoRawControls(output, { message: `safe notice at width ${width}` });
				if (width === 160) {
					assert.ok(output.includes("Ω日本語\\x1b]0;TITLE\\x07"));
					assert.ok(output.includes("\\x9b2J\\x08\\x00\\x7f\\x90DCS\\x9c"));
				}
			}
			assertNoRawControls(message.content!);
			assert.deepEqual(message.details, originalDetails);
		} finally {
			unsubscribe();
		}
	});

	// PR #2700: structured results can carry controls in selected labels and fallback kinds too.
	test("renders brokered questionnaire answers safely while retaining the exact submitted result", async () => {
		const { broker, sent, options, registered, unsubscribe } = setup();
		const hostile = "Ω日本語\x1b]0;CHOICE\x07\x1b[2J\x9b2J\x08";
		const question = `Question ${hostile}`;
		const adapter = buildStagePromptAdapter(
			"ask-hostile",
			"ask_user_question",
			{
				questions: [{ question, options: [{ label: hostile }, { label: "Safe" }] }],
			},
			1,
		)!;
		broker.provideStagePrompt("run-1", "stage-1", adapter);
		let request: StageCustomUiRequest | undefined;
		const unregister = broker.registerHost("run-1", "stage-1", {
			showCustomUi(next) {
				request = next;
			},
		});
		try {
			const pending = broker.requestCustomUi("run-1", "stage-1", () => ({ render: () => [], invalidate() {} }));
			assert.ok(request);
			const result = {
				answers: [
					{ question, answer: `Answer ${hostile}` },
					{ question: "Selected", selected: [hostile] },
					{ question: "Fallback", kind: hostile },
				],
				cancelled: false,
			};
			const original = structuredClone(result);
			broker.resolve(request, result);
			assert.strictEqual(await pending, result);
			assert.equal(sent.length, 1);
			assert.deepEqual(options[0], { triggerTurn: false, excludeFromContext: true });
			const message = sent[0]!;
			assert.equal(message.details?.promptMessage, question);
			assert.equal(
				message.details?.answerSummary,
				`${question} → Answer ${hostile}; Selected → ${hostile}; Fallback → (${hostile})`,
			);
			const component = registered[0]!.renderer(message) as CardComponent;
			for (const width of [160, 40, 24]) {
				assertNoRawControls(component.render(width).join("\n"));
			}
			assertNoRawControls(message.content!);
			assert.ok(message.content!.includes("Selected → Ω日本語\\x1b]0;CHOICE\\x07"));
			assert.ok(message.content!.includes("Fallback → (Ω日本語\\x1b]0;CHOICE\\x07"));
			assert.deepEqual(result, original);
		} finally {
			unregister();
			unsubscribe();
		}
	});

	// PR #2700: replayed notices predate send-time sanitization; each field is independently untrusted.
	for (const field of [
		"workflowName",
		"runId",
		"stageId",
		"stageName",
		"promptId",
		"promptMessage",
		"answerSummary",
	] as const) {
		test(`escapes raw historical notice ${field} in card and fallback without mutating details`, () => {
			const registered: RegisteredRenderer[] = [];
			registerHilAnswerNoticeRenderer({
				registerMessageRenderer(event, renderer) {
					registered.push({ event, renderer: renderer as (payload: unknown) => unknown });
				},
			});
			const details: WorkflowHilAnswerNoticeDetails = {
				kind: "hil_answered",
				scope: "stage",
				runId: "run-history",
				workflowName: "release",
				stageId: "stage-history",
				promptId: "prompt-history",
				promptKind: "input",
				promptMessage: "Question",
				answeredAt: 1,
				answerAvailable: true,
				answerIncluded: true,
				answerSummary: "Answer",
				[field]: "Ω日本語\x1b]0;HISTORY\x07\x1b[2J\x9b2J\x08",
			};
			const original = structuredClone(details);
			const component = registered[0]!.renderer({ details, content: "old raw\x1b[2J" }) as CardComponent;
			for (const width of [160, 80, 32, 24, 1]) {
				assertNoRawControls(component.render(width).join("\n"));
			}
			if (field !== "promptId") {
				assert.ok(component.render(160).join("\n").includes("Ω日本語\\x1b]0;HISTORY\\x07"));
			}
			assert.deepEqual(details, original);
		});
	}

	test("emits one display-only notice when a simple stage prompt is answered", () => {
		const { store, sent, options, unsubscribe } = setup();

		assert.equal(store.recordStagePendingPrompt("run-1", "stage-1", pendingPrompt()), true);
		assert.equal(store.resolveStagePendingPrompt("run-1", "stage-1", "prompt-1", "swordfish"), true);
		store.recordNotice({ id: "tick", level: "info", message: "force notify", createdAt: 20 });
		store.clearStagePromptAnswer("run-1", "stage-1");

		assert.equal(sent.length, 1);
		assert.deepEqual(options[0], { triggerTurn: false, excludeFromContext: true });
		assert.equal(sent[0]?.customType, HIL_ANSWER_NOTICE_CUSTOM_TYPE);
		assert.equal(sent[0]?.display, true);
		assert.equal(sent[0]?.details?.kind, "hil_answered");
		assert.equal(sent[0]?.details?.scope, "stage");
		assert.equal(sent[0]?.details?.runId, "run-1");
		assert.equal(sent[0]?.details?.workflowName, "release");
		assert.equal(sent[0]?.details?.stageId, "stage-1");
		assert.equal(sent[0]?.details?.stageName, "review");
		assert.equal(sent[0]?.details?.promptId, "prompt-1");
		assert.equal(sent[0]?.details?.promptKind, "input");
		assert.equal(sent[0]?.details?.answerAvailable, true);
		assert.equal(sent[0]?.details?.answerIncluded, true);
		assert.equal(sent[0]?.details?.answerSummary, "swordfish");
		assert.equal(sent[0]?.details?.promptMessage, "Secret passphrase?");
		assert.equal(typeof sent[0]?.details?.answeredAt, "number");
		assert.match(sent[0]?.content ?? "", /received the user's response/);
		assert.match(sent[0]?.content ?? "", /User responded with: swordfish/);
		assert.match(sent[0]?.content ?? "", /Do not ask the same question again/);
		assert.match(sent[0]?.content ?? "", /No main-chat action is needed/);
		assert.match(
			sent[0]?.content ?? "",
			/do not answer any other workflow human-in-the-loop prompt unless the user explicitly provides that answer/,
		);
		unsubscribe();
	});

	test("does not notify when a simple prompt is cleared without recording an answer", () => {
		const { store, sent, unsubscribe } = setup();

		assert.equal(store.recordStagePendingPrompt("run-1", "stage-1", pendingPrompt()), true);
		assert.equal(
			store.resolveStagePendingPrompt("run-1", "stage-1", "prompt-1", "discarded", { recordAnswer: false }),
			true,
		);

		assert.deepEqual(sent, []);
		unsubscribe();
	});

	test("does not notify when a simple prompt is answered by the workflow tool", () => {
		const { store, sent, unsubscribe } = setup();

		assert.equal(store.recordStagePendingPrompt("run-1", "stage-1", pendingPrompt()), true);
		assert.equal(
			store.resolveStagePendingPrompt("run-1", "stage-1", "prompt-1", "from tool", {
				answerSource: "workflow_tool",
			}),
			true,
		);
		store.recordNotice({ id: "tick", level: "info", message: "force notify", createdAt: 20 });

		assert.deepEqual(sent, []);
		unsubscribe();
	});

	test("emits exactly one custom prompt notice when awaiting clears before the answer is recorded", async () => {
		const { store, broker, sent, options, unsubscribe } = setup();
		const prompt = pendingPrompt({
			id: "custom-1",
			kind: "custom",
			message: "Approval widget",
			customIdentityHash: "identity-hash",
			customIdentitySource: "caller",
		});
		store.recordStageStart(
			"run-1",
			runningStage({
				id: "custom-stage",
				name: "custom",
				promptFootprint: prompt,
			}),
		);

		let request: StageCustomUiRequest<string> | undefined;
		const unregisterHost = broker.registerHost("run-1", "custom-stage", {
			showCustomUi(next) {
				request = next as StageCustomUiRequest<string>;
			},
		});
		try {
			const pending = broker.requestCustomUi<string>("run-1", "custom-stage", () => ({
				render: () => [],
				invalidate: () => {},
			}));
			assert.ok(request, "custom request should mount on the registered host");
			broker.resolve(request, "approved");
			assert.equal(await pending, "approved");

			const afterBrokerResolve = store.runs()[0]?.stages.find((stage) => stage.id === "custom-stage");
			assert.equal(afterBrokerResolve?.status, "running");
			assert.equal(afterBrokerResolve?.promptAnswerState, undefined);
			assert.equal(sent.length, 0);

			assert.equal(store.recordStagePromptAnswer("run-1", "custom-stage", prompt, "approved"), true);
			store.recordNotice({ id: "tick-1", level: "info", message: "force notify", createdAt: 21 });
			assert.equal(store.recordStagePromptAnswer("run-1", "custom-stage", prompt, "approved-again"), true);
			store.recordNotice({ id: "tick-2", level: "info", message: "force notify again", createdAt: 22 });

			assert.equal(sent.length, 1);
			assert.deepEqual(options[0], { triggerTurn: false, excludeFromContext: true });
			assert.equal(sent[0]?.customType, HIL_ANSWER_NOTICE_CUSTOM_TYPE);
			assert.equal(sent[0]?.display, true);
			assert.equal(sent[0]?.details?.promptId, "custom-1");
			assert.equal(sent[0]?.details?.promptKind, "custom");
			assert.equal(sent[0]?.details?.promptMessage, "Approval widget");
			assert.equal(sent[0]?.details?.answerSummary, "approved");
			assert.match(sent[0]?.content ?? "", /User responded with: approved/);
		} finally {
			unregisterHost();
			unsubscribe();
		}
	});

	test("does not notify when a custom prompt answer comes from the workflow tool", () => {
		const { store, sent, unsubscribe } = setup();
		const prompt = pendingPrompt({
			id: "custom-tool-1",
			kind: "custom",
			message: "Tool-supplied widget",
			customIdentityHash: "identity-hash",
			customIdentitySource: "caller",
		});
		store.recordStageStart(
			"run-1",
			runningStage({
				id: "custom-tool-stage",
				name: "custom",
				promptFootprint: prompt,
			}),
		);

		assert.equal(
			store.recordStagePromptAnswer("run-1", "custom-tool-stage", prompt, "from tool", {
				answerSource: "workflow_tool",
			}),
			true,
		);
		store.recordNotice({ id: "tick", level: "info", message: "force notify", createdAt: 20 });

		assert.deepEqual(sent, []);
		unsubscribe();
	});

	test("emits a display-only notice when a brokered structured prompt is answered", async () => {
		const { broker, sent, options, unsubscribe } = setup();
		const adapter = buildStagePromptAdapter("ask-1", "ask_user_question", COLOR_ARGS, 1)!;
		broker.provideStagePrompt("run-1", "stage-1", adapter);

		const pending = broker.requestCustomUi("run-1", "stage-1", () => ({
			render: () => [],
			invalidate: () => {},
		}));

		assert.equal(broker.answerStagePrompt("run-1", "stage-1", { text: "Blue" }), true);
		await pending;

		assert.equal(sent.length, 1);
		assert.deepEqual(options[0], { triggerTurn: false, excludeFromContext: true });
		assert.equal(sent[0]?.customType, HIL_ANSWER_NOTICE_CUSTOM_TYPE);
		assert.equal(sent[0]?.details?.promptId, "ask-1");
		assert.equal(sent[0]?.details?.promptKind, "ask_user_question");
		assert.equal(sent[0]?.details?.answerAvailable, true);
		assert.equal(sent[0]?.details?.answerIncluded, true);
		assert.equal(sent[0]?.details?.answerSummary, "What color? → Blue");
		assert.equal(sent[0]?.details?.promptMessage, "What color?");
		assert.match(sent[0]?.content ?? "", /User responded with: What color\? → Blue/);
		assert.match(sent[0]?.content ?? "", /No main-chat action is needed/);
		unsubscribe();
	});

	// PR2700 LIVE-U1: Cancel retains drafts but must not announce a successful answer.
	for (const answers of [[], [{ question: "What color?", answer: "Amber", selected: ["Amber"] }]]) {
		test(`does not announce a cancelled questionnaire with ${answers.length} draft answers`, async () => {
			const { broker, sent, unsubscribe } = setup();
			const adapter = buildStagePromptAdapter(
				"ask-cancel",
				"ask_user_question",
				{
					questions: [
						{ question: "What color?", options: [{ label: "Amber" }, { label: "Blue" }] },
						{ question: "What shape?", options: [{ label: "Square" }, { label: "Circle" }] },
					],
				},
				1,
			)!;
			broker.provideStagePrompt("run-1", "stage-1", adapter);
			let request: StageCustomUiRequest | undefined;
			const unregister = broker.registerHost("run-1", "stage-1", {
				showCustomUi(next) {
					request = next;
				},
			});
			try {
				const pending = broker.requestCustomUi("run-1", "stage-1", () => ({
					render: () => [],
					invalidate: () => {},
				}));
				assert.ok(request);
				const result = { answers, cancelled: true };
				broker.resolve(request, result);
				assert.strictEqual(await pending, result, "retain the exact cancelled result and ordered drafts");
				assert.deepEqual(sent, [], "cancellation must not create a HIL ANSWERED notice");
			} finally {
				unregister();
				unsubscribe();
			}
		});
	}

	test("does not notify when a brokered structured prompt is answered by the workflow tool", async () => {
		const { broker, sent, unsubscribe } = setup();
		const adapter = buildStagePromptAdapter("ask-1", "ask_user_question", COLOR_ARGS, 1)!;
		broker.provideStagePrompt("run-1", "stage-1", adapter);

		const pending = broker.requestCustomUi("run-1", "stage-1", () => ({
			render: () => [],
			invalidate: () => {},
		}));

		assert.equal(
			broker.answerStagePrompt("run-1", "stage-1", { text: "Blue" }, { answerSource: "workflow_tool" }),
			true,
		);
		await pending;

		assert.deepEqual(sent, []);
		unsubscribe();
	});

	test("registers HiL answer renderer once per host and returns a notice card", () => {
		const host = {};
		const registered: RegisteredRenderer[] = [];
		registerHilAnswerNoticeRenderer({
			rendererHost: host,
			registerMessageRenderer(event, renderer) {
				registered.push({ event, renderer: renderer as (payload: unknown) => unknown });
			},
		});
		registerHilAnswerNoticeRenderer({
			rendererHost: host,
			registerMessageRenderer(event, renderer) {
				registered.push({ event, renderer: renderer as (payload: unknown) => unknown });
			},
		});

		assert.equal(registered.length, 1);
		assert.equal(registered[0]?.event, HIL_ANSWER_NOTICE_CUSTOM_TYPE);
		const rendered = registered[0]?.renderer({
			details: {
				kind: "hil_answered",
				scope: "stage",
				runId: "run-card",
				workflowName: "release",
				stageId: "stage-1",
				stageName: "review",
				promptId: "prompt-1",
				promptKind: "input",
				promptMessage: "Secret passphrase?",
				answeredAt: 1,
				answerAvailable: true,
				answerIncluded: true,
				answerSummary: "swordfish",
			} satisfies WorkflowHilAnswerNoticeDetails,
		});

		assert.equal(typeof rendered, "object");
		assert.notEqual(rendered, null);
		const lines = (rendered as CardComponent).render(80);
		const text = lines.join("\n");
		assert.match(text, /╭ HIL ANSWERED/);
		assert.match(text, /✓ Workflow "release" received the user's response/);
		assert.match(text, /stage\s+review/);
		assert.match(text, /answer\s+swordfish/);
		for (const width of [80, 40, 24]) {
			for (const line of (rendered as CardComponent).render(width)) {
				assert.ok(line.length === 0 || line.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").length <= width);
			}
		}
	});
});
