import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { DecisionRequestError } from "../../packages/coding-agent/src/core/decision/errors.js";
import { InMemorySettingsStorage, SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { decisionSettingScopes } from "../../packages/coding-agent/src/modes/interactive/components/settings-selector-items.js";
import { renderResult } from "../../packages/workflows/src/extension/render-result.js";
import {
	autoAdvanceAfterSteerSetting,
	workflowModelCatalogFromContext,
} from "../../packages/workflows/src/extension/workflow-model-catalog.js";
import {
	snapshotTranscriptEntries,
	snapshotTranscriptEntryCount,
	summarizeStage,
} from "../../packages/workflows/src/extension/workflow-stage-results.js";
import { renderWorkflowToolContent } from "../../packages/workflows/src/extension/workflow-tool-content.js";
import { toolResultChatText, userMessageText } from "../../packages/workflows/src/runs/foreground/executor-hil.js";
import {
	describeReadinessDecision,
	READINESS_DECISION_QUESTIONS,
	type StageReadinessDecision,
} from "../../packages/workflows/src/runs/foreground/readiness-decision.js";
import type { StageNotice, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import {
	noticeRow,
	noticeSummary,
	stageNoticeCard,
} from "../../packages/workflows/src/tui/stage-chat-view-transcript.js";
import { decisionChatModel } from "../helpers/structured-output.js";

const ADVANCED: StageReadinessDecision = {
	outcome: "advanced",
	at: 20,
	model: "typesafe/jev-latest",
	probabilities: { advance: 0.93, stay: 0.07, addressed: 0.91 },
};

function decisionNotice(decision: StageReadinessDecision): StageNotice {
	return {
		id: "n1",
		ts: decision.at,
		kind: "decision",
		to: decision.outcome,
		...(decision.model === undefined ? {} : { from: decision.model }),
		meta: describeReadinessDecision(decision),
	};
}

function stage(overrides: Partial<StageSnapshot> = {}): StageSnapshot {
	return { id: "s1", name: "theme", status: "completed", parentIds: [], ...overrides } as StageSnapshot;
}

test("workflows.autoAdvanceAfterSteer defaults to true, including the array form of workflows (#4358)", () => {
	assert.equal(autoAdvanceAfterSteerSetting(undefined), true);
	assert.equal(autoAdvanceAfterSteerSetting({}), true);
	assert.equal(autoAdvanceAfterSteerSetting({ workflows: ["./flows"] }), true);
	assert.equal(autoAdvanceAfterSteerSetting({ workflows: {} }), true);
	assert.equal(autoAdvanceAfterSteerSetting({ workflows: { autoAdvanceAfterSteer: true } }), true);
	assert.equal(autoAdvanceAfterSteerSetting({ workflows: { autoAdvanceAfterSteer: false } }), false);
});

test("the settings accessor keeps workflow paths when it writes the array form, and honors project scope", () => {
	const manager = SettingsManager.inMemory({ workflows: ["./flows"] });
	assert.equal(manager.getAutoAdvanceAfterSteer(), true);
	manager.setAutoAdvanceAfterSteer(false);
	assert.equal(manager.getAutoAdvanceAfterSteer(), false);
	assert.deepEqual(manager.getWorkflowPaths(), ["./flows"]);
	assert.deepEqual(manager.getGlobalSettings().workflows, { paths: ["./flows"], autoAdvanceAfterSteer: false });
	manager.setAutoAdvanceAfterSteer(true);
	assert.deepEqual(manager.getGlobalSettings().workflows, { paths: ["./flows"], autoAdvanceAfterSteer: true });
	const objectForm = SettingsManager.inMemory({ workflows: { paths: ["a"], autoAdvanceAfterSteer: false } });
	assert.equal(objectForm.getAutoAdvanceAfterSteer(), false);
	objectForm.setAutoAdvanceAfterSteer(true, "project");
	assert.deepEqual(objectForm.getProjectSettings().workflows, { autoAdvanceAfterSteer: true });
	assert.equal(objectForm.getAutoAdvanceAfterSteer(), true);
	assert.equal(SettingsManager.inMemory().getAutoAdvanceAfterSteer(), true);
});

test("the host decision port binds decide() to the live context and reads the setting live", async () => {
	const settings = { workflows: { autoAdvanceAfterSteer: true } };
	const streamSimple = vi.fn();
	const containsConfiguredCredential = vi.fn(async (text: string) => text.includes("configured-secret"));
	const catalog = workflowModelCatalogFromContext(
		{
			model: decisionChatModel,
			getDecisionModel: () => "missing/model",
			modelRegistry: {
				getAvailable: () => [decisionChatModel],
				getAll: () => [decisionChatModel],
				streamSimple,
				containsConfiguredCredential,
			},
		},
		undefined,
		() => settings,
	);
	assert.ok(catalog?.decide);
	assert.equal(catalog.autoAdvanceAfterSteer?.(), true);
	settings.workflows.autoAdvanceAfterSteer = false;
	assert.equal(catalog.autoAdvanceAfterSteer?.(), false);
	await assert.rejects(
		catalog.decide({ state: { note: "configured-secret" }, questions: READINESS_DECISION_QUESTIONS }),
		(error: unknown) =>
			error instanceof DecisionRequestError && error.reason === "credential-in-state" && error.field === "state",
	);
	await assert.rejects(
		catalog.decide({ state: { note: "plain" }, questions: READINESS_DECISION_QUESTIONS }),
		(error: unknown) => (error as { reason?: string }).reason === "not-in-catalog",
	);
	assert.equal(containsConfiguredCredential.mock.calls.length, 2);
	assert.equal(streamSimple.mock.calls.length, 0);
	const withoutDecisionModel = workflowModelCatalogFromContext({
		model: decisionChatModel,
		modelRegistry: { getAvailable: () => [decisionChatModel] },
	});
	assert.equal(withoutDecisionModel?.decide, undefined);
	assert.equal(withoutDecisionModel?.autoAdvanceAfterSteer, undefined);
});

test("the host decision port refuses a host without a model registry", async () => {
	const catalog = workflowModelCatalogFromContext({
		model: decisionChatModel,
		getDecisionModel: () => "",
		modelRegistry: { getAvailable: () => [decisionChatModel] },
	});
	await assert.rejects(
		catalog!.decide!({ state: { a: "b" }, questions: READINESS_DECISION_QUESTIONS }),
		/Workflow decisions require host decision model and model registry support/,
	);
});

test("the user's message is read from a typed chat answer and from message content", () => {
	const chat = (answer: unknown, kind = "chat") => ({ details: { answers: [{ kind, answer }] } });
	assert.equal(toolResultChatText(chat("Use blue.")), "Use blue.");
	assert.equal(toolResultChatText(chat("Chat about this")), undefined);
	assert.equal(toolResultChatText(chat("  Chat about this  ")), undefined);
	assert.equal(toolResultChatText(chat("   ")), undefined);
	assert.equal(toolResultChatText(chat("Use blue.", "custom")), undefined);
	assert.equal(toolResultChatText(chat(7)), undefined);
	assert.equal(
		toolResultChatText({
			details: { answers: [{ kind: "chat", answer: "One." }, null, { kind: "chat", answer: "Two." }] },
		}),
		"One.\n\nTwo.",
	);
	assert.equal(toolResultChatText({ details: { answers: "x" } }), undefined);
	assert.equal(toolResultChatText({ details: null }), undefined);
	assert.equal(toolResultChatText(null), undefined);
	assert.equal(userMessageText("Hi"), "Hi");
	assert.equal(userMessageText("  "), undefined);
	assert.equal(
		userMessageText([
			{ type: "text", text: "Look " },
			{ type: "image", data: "x" },
			{ type: "text", text: "here" },
		]),
		"Look \nhere",
	);
	assert.equal(userMessageText([{ type: "image", data: "x" }]), undefined);
	assert.equal(userMessageText([null, { type: "text" }]), undefined);
	assert.equal(userMessageText(undefined), undefined);
});

test("stage status lists the readiness decision, and the transcript shows it as a notice", () => {
	const snapshot = stage({
		readinessDecision: ADVANCED,
		notices: [decisionNotice(ADVANCED)],
		result: "Done",
		endedAt: 30,
	});
	const summary = summarizeStage(snapshot);
	assert.deepEqual(summary.readinessDecision, ADVANCED);
	assert.notEqual(summary.readinessDecision, ADVANCED);
	assert.equal(Object.hasOwn(summarizeStage(stage()), "readinessDecision"), false);
	assert.equal(snapshotTranscriptEntryCount(undefined), 0);
	const entries = snapshotTranscriptEntries(snapshot, false);
	assert.deepEqual(entries, [
		{ role: "notice", text: "Decision model advanced the stage (p=0.93, addressed p=0.91)", timestamp: 20 },
		{ role: "assistant", text: "Done", timestamp: 30 },
	]);
	assert.equal(snapshotTranscriptEntryCount(snapshot), 2);
	const other = stage({ notices: [{ id: "m", ts: 1, kind: "model", to: "x" }] });
	assert.deepEqual(snapshotTranscriptEntries(other, false), []);
	assert.equal(snapshotTranscriptEntryCount(other), 0);
	assert.deepEqual(
		snapshotTranscriptEntries(stage({ notices: [{ id: "d", ts: 2, kind: "decision", to: "asked" }] }), false),
		[{ role: "notice", text: "decision → asked", timestamp: 2 }],
	);
	const listing = { action: "stages" as const, runId: "r1", filter: "all", stages: [summary] };
	assert.match(
		renderWorkflowToolContent(listing, { action: "stages" }),
		/readinessDecision: Decision model advanced the stage \(p=0\.93, addressed p=0\.91\)/,
	);
	assert.match(renderResult(listing), /theme \(s1\): completed — Decision model advanced the stage/);
	assert.doesNotMatch(
		renderWorkflowToolContent({ ...listing, stages: [summarizeStage(stage())] }, { action: "stages" }),
		/readinessDecision/,
	);
});

test("the connect view renders each readiness outcome as a stage readiness card", () => {
	const theme = deriveGraphTheme({});
	const render = (decision: StageReadinessDecision): string => {
		const notice = decisionNotice(decision);
		return noticeRow(
			{
				role: "notice",
				noticeId: notice.id,
				kind: notice.kind,
				value: notice.to,
				...(notice.from === undefined ? {} : { from: notice.from }),
				...(notice.meta === undefined ? {} : { meta: notice.meta }),
				text: noticeSummary(notice),
			},
			theme,
		)
			.render(120)
			.join("\n");
	};
	const advanced = render(ADVANCED);
	assert.match(advanced, /STAGE READINESS/);
	assert.match(advanced, /✓/);
	assert.match(advanced, /Decision model advanced the stage \(p=0\.93/);
	assert.match(advanced, /typesafe\/jev-latest/);
	const stayed = render({
		...ADVANCED,
		outcome: "stayed",
		probabilities: { advance: 0.1, stay: 0.9, addressed: 0.2 },
	});
	assert.match(stayed, /Decision model kept the stage open \(p=0\.90\)/);
	assert.match(stayed, /◆/);
	const asked = render({ outcome: "asked", at: 1, error: { name: "DecisionTimeoutError", code: "timeout" } });
	assert.match(asked, /Decision model failed \(timeout\); asked whether to move on/);
	assert.match(asked, /\?/);
	assert.equal(
		noticeSummary(decisionNotice(ADVANCED)),
		"~ Decision model advanced the stage (p=0.93, addressed p=0.91)",
	);
	assert.equal(noticeSummary({ id: "d", ts: 1, kind: "decision", to: "asked" }), "~ decision → asked");
	assert.equal(noticeSummary({ id: "m", ts: 1, kind: "model", from: "a", to: "b" }), "~ model → b (was a)");
});

test("the setting is saved to the settings file of the scope it was set in", async () => {
	const storage = new InMemorySettingsStorage();
	storage.withLock("global", () => JSON.stringify({ workflows: ["./flows"], theme: "dark" }));
	storage.withLock("project", () => JSON.stringify({ workflows: { paths: ["p"] } }));
	const manager = SettingsManager.fromStorage(storage, { projectTrusted: true });
	manager.setAutoAdvanceAfterSteer(false);
	manager.setAutoAdvanceAfterSteer(true, "project");
	await manager.flush();
	const read = (scope: "global" | "project") => {
		let content: string | undefined;
		storage.withLock(scope, (current) => {
			content = current;
			return undefined;
		});
		return JSON.parse(content ?? "{}") as { workflows?: unknown };
	};
	assert.deepEqual(read("global").workflows, { paths: ["./flows"], autoAdvanceAfterSteer: false });
	assert.deepEqual(read("project").workflows, { paths: ["p"], autoAdvanceAfterSteer: true });
	assert.equal(manager.getAutoAdvanceAfterSteer(), true);
});

test("/settings saves each decision setting where the project already sets it, otherwise globally", () => {
	assert.deepEqual(decisionSettingScopes({}), { decisionModelScope: "global", autoAdvanceAfterSteerScope: "global" });
	assert.deepEqual(decisionSettingScopes({ decisionModel: "", workflows: { autoAdvanceAfterSteer: false } }), {
		decisionModelScope: "project",
		autoAdvanceAfterSteerScope: "project",
	});
	assert.deepEqual(decisionSettingScopes({ workflows: ["./flows"] }), {
		decisionModelScope: "global",
		autoAdvanceAfterSteerScope: "global",
	});
	assert.deepEqual(decisionSettingScopes({ workflows: { paths: [] } }).autoAdvanceAfterSteerScope, "global");
});

test("each readiness outcome gets its own card in the connect view", () => {
	const card = (value: string, meta?: string, from?: string) =>
		stageNoticeCard({
			role: "notice",
			noticeId: "n",
			kind: "decision",
			value,
			text: "",
			...(meta === undefined ? {} : { meta }),
			...(from === undefined ? {} : { from }),
		});
	assert.deepEqual(card("advanced", "Decision model advanced the stage (p=0.93)", "typesafe/jev-latest"), {
		title: "STAGE READINESS",
		glyph: "✓",
		headline: "Decision model advanced the stage (p=0.93)",
		tone: "success",
		fields: [
			{ label: "outcome", value: "advanced", tone: "text" },
			{ label: "model", value: "typesafe/jev-latest", tone: "muted" },
		],
	});
	assert.deepEqual(
		[card("stayed").glyph, card("stayed").tone, card("asked").glyph, card("asked").tone],
		["◆", "info", "?", "warning"],
	);
	assert.equal(card("asked").headline, "Decision model judged the stage's readiness");
});

test("a record without probabilities still describes itself", () => {
	assert.equal(
		describeReadinessDecision({ outcome: "advanced", at: 1 }),
		"Decision model advanced the stage (p=0.00, addressed p=0.00)",
	);
	assert.equal(describeReadinessDecision({ outcome: "stayed", at: 1 }), "Decision model kept the stage open (p=0.00)");
});

test("the user's message reader ignores missing results, details and answers", () => {
	assert.equal(toolResultChatText(undefined), undefined);
	assert.equal(toolResultChatText({}), undefined);
	assert.equal(toolResultChatText({ details: {} }), undefined);
	assert.equal(
		toolResultChatText({ details: { answers: [undefined, "text", { kind: "chat", answer: "Hi." }] } }),
		"Hi.",
	);
	assert.equal(userMessageText([undefined, "text", { type: "text", text: "Hi" }]), "Hi");
	assert.equal(userMessageText(7), undefined);
});

test("the host decision port decides with the live context's decision model, registry and chat model", async () => {
	const { decisionMessage, messageStream } = await import("../helpers/structured-output.js");
	const streamSimple = vi.fn(() =>
		messageStream(decisionMessage({ next_action: "advance", reply_addresses_message: true })),
	);
	const launch = {
		model: decisionChatModel,
		getDecisionModel: () => "missing/model",
		modelRegistry: { getAvailable: () => [decisionChatModel] },
	};
	const live = {
		model: decisionChatModel,
		getDecisionModel: () => "",
		getHttpIdleTimeoutMs: () => 60_000,
		modelRegistry: {
			getAvailable: () => [decisionChatModel],
			getAll: () => [decisionChatModel],
			streamSimple,
			getClassifierModel: () => undefined,
		},
	};
	const catalog = workflowModelCatalogFromContext(launch, () => live);
	const result = await catalog!.decide!({ state: { note: "plain" }, questions: READINESS_DECISION_QUESTIONS });
	assert.equal(result.model, "decision-test/chat");
	assert.equal(result.source, "chat");
	assert.equal(result.answers.next_action.choice, "advance");
	assert.equal(streamSimple.mock.calls.length, 1);
	const withoutStream = workflowModelCatalogFromContext(launch, () => ({
		...live,
		modelRegistry: { getAvailable: () => [decisionChatModel], getAll: () => [decisionChatModel] },
	}));
	await assert.rejects(
		withoutStream!.decide!({ state: { a: "b" }, questions: READINESS_DECISION_QUESTIONS }),
		/require host decision model and model registry support/,
	);
	const withoutLiveSetting = workflowModelCatalogFromContext(launch, () => ({
		...live,
		getDecisionModel: undefined,
	}));
	await assert.rejects(
		withoutLiveSetting!.decide!({ state: { a: "b" }, questions: READINESS_DECISION_QUESTIONS }),
		/require host decision model and model registry support/,
	);
	assert.equal(catalog!.autoAdvanceAfterSteer?.(), true);
});
