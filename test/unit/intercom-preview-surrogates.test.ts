import assert from "node:assert/strict";
import type { PendingRecoveryDelivery, Theme, ToolDefinition } from "@bastani/atomic";
import { afterEach, test } from "vitest";
import { boundedReleaseReasons } from "../../packages/intercom/broker/restoring-recipients.js";
import intercom from "../../packages/intercom/index.js";
import { previewText } from "../../packages/intercom/intercom-utils.js";
import { planIntercomRecoveryReplay } from "../../packages/intercom/session-recovery.js";
import type { SessionInfo } from "../../packages/intercom/types.js";

const EMOJI = "😀";
const ORCHESTRATOR_TARGET_ENV = "ATOMIC_SUBAGENT_ORCHESTRATOR_TARGET";
const previousOrchestratorTarget = process.env[ORCHESTRATOR_TARGET_ENV];

afterEach(() => {
	if (previousOrchestratorTarget === undefined) delete process.env[ORCHESTRATOR_TARGET_ENV];
	else process.env[ORCHESTRATOR_TARGET_ENV] = previousOrchestratorTarget;
});

function goneCard(text: string): PendingRecoveryDelivery {
	const from: SessionInfo = {
		id: "gone-id",
		name: "gone",
		cwd: "/repo",
		model: "m",
		pid: 1,
		startedAt: 1,
		lastActivity: 1,
	};
	const timestamp = Date.UTC(2026, 9, 19, 7, 0, 0);
	return {
		entryId: "gone",
		customType: "intercom_message",
		content: text,
		details: { from, message: { id: "gone-message", timestamp, content: { text } }, bodyText: text },
		timestamp: new Date(timestamp).toISOString(),
		stageAdmissionKey: "intercom:gone-message",
		delivery: "steer",
	};
}

function recoveredHistory(text: string): string {
	const notice = planIntercomRecoveryReplay([goneCard(text)], []).notices?.[0] ?? "";
	return notice.slice(notice.indexOf("- Sent 2026-10-19T07:00:00.000Z: ") + 33);
}

/** The contact_supervisor call line a subagent shows for `message`. */
function contactSupervisorCallLine(message: string): string {
	process.env[ORCHESTRATOR_TARGET_ENV] = "supervisor";
	const tools: ToolDefinition[] = [];
	intercom({
		on() {},
		registerTool: (tool: ToolDefinition) => tools.push(tool),
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		getSessionName: () => undefined,
		events: { on: () => () => {}, emit() {} },
	} as never);
	const tool = tools.find((candidate) => candidate.name === "contact_supervisor");
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
	const component = tool?.renderCall?.({ reason: "progress_update", message }, theme, {} as never);
	return (component?.render(1_000) ?? []).map((line) => line.trimEnd()).join("\n");
}

test("an Intercom message preview cuts before a split emoji (#5097)", () => {
	assert.equal(previewText("p".repeat(72)), "p".repeat(72));
	assert.equal(previewText(`${"p".repeat(70)}${EMOJI}x`), `${"p".repeat(70)}…`);
	assert.equal(previewText(`${"p".repeat(8)}${EMOJI}x`, 10), `${"p".repeat(8)}…`);
});

test("a recovered message from a gone peer cuts its body before a split emoji (#5097)", () => {
	assert.equal(recoveredHistory("b".repeat(2_000)), "b".repeat(2_000));
	assert.equal(recoveredHistory(`${"b".repeat(1_999)}${EMOJI}`), `${"b".repeat(1_999)}…`);
});

test("the broker bounds a restoring child's release reasons without splitting an emoji (#5097)", () => {
	assert.deepEqual(boundedReleaseReasons(undefined, undefined), { gone: undefined, refusal: undefined });
	assert.deepEqual(boundedReleaseReasons("lost", "  "), { gone: "lost", refusal: undefined });
	assert.deepEqual(boundedReleaseReasons(undefined, "moved"), { gone: undefined, refusal: "moved" });
	assert.deepEqual(boundedReleaseReasons(`${"g".repeat(1_000)}z`, `${"r".repeat(999)}${EMOJI}`), {
		gone: "g".repeat(1_000),
		refusal: "r".repeat(999),
	});
	// The first and last high surrogates: U+10000 and U+10FFFF.
	assert.deepEqual(boundedReleaseReasons(`${"g".repeat(999)}\u{10000}`, `${"r".repeat(999)}\u{10FFFF}`), {
		gone: "g".repeat(999),
		refusal: "r".repeat(999),
	});
	assert.deepEqual(boundedReleaseReasons(`${"g".repeat(998)}${EMOJI}`, "r".repeat(1_000)), {
		gone: `${"g".repeat(998)}${EMOJI}`,
		refusal: "r".repeat(1_000),
	});
});

test("a subagent's contact_supervisor call line cuts a long message before a split emoji (#5097)", () => {
	assert.equal(contactSupervisorCallLine("m".repeat(96)), `contact_supervisor progress_update\n  ${"m".repeat(96)}`);
	assert.equal(
		contactSupervisorCallLine(`${"m".repeat(92)}${EMOJI}${"m".repeat(3)}`),
		`contact_supervisor progress_update\n  ${"m".repeat(92)}...`,
	);
	assert.equal(contactSupervisorCallLine("   "), "contact_supervisor progress_update");
});
