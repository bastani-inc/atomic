import { HeartbeatBlock, type HeartbeatRow } from "@bastani/atomic";
import {
	WORKFLOW_HEARTBEAT_CUSTOM_TYPE,
	type WorkflowHeartbeatEventDetails,
} from "../shared/workflow-heartbeat-contract.js";
import { inertDisplayLine } from "../tui/display-text.js";
import type { ExtensionAPI, PiMessageRenderComponent, PiMessageRenderer } from "./index.js";

/** The model-facing text's mark; the rendered notice takes it from the shared notice glyphs. */
const WORKFLOW_HEARTBEAT_GLYPH = "♥";

const rendererRegisteredHosts = new WeakSet<object>();

/**
 * Model-facing heartbeat text. Derived only from the five slice-1 payload
 * fields: it names the workflow and run so the parent can identify the work,
 * states the cadence and elapsed time so it can judge drift, and points at the
 * existing status surface so it can inspect rather than guess.
 */
export function formatWorkflowHeartbeatNoticeText(details: WorkflowHeartbeatEventDetails): string {
	const workflowName = escapeQuotedText(details.workflowName);
	const elapsed = formatWorkflowHeartbeatElapsed(details);
	const cadence = formatWorkflowHeartbeatCadence(details.intervalMinutes);
	return (
		`${WORKFLOW_HEARTBEAT_GLYPH} Workflow "${workflowName}" heartbeat (run ${details.runId}) — still running` +
		`${elapsed === undefined ? "" : ` after ${elapsed}`}, on a ${cadence} cadence. ` +
		"This is a periodic alignment check. Review whether the run is still on goal. " +
		"When steering or communication is useful, use Intercom. Before steering a stage, join its invocation group. " +
		"Use the Intercom `groups` action to discover it. Workflow invocation groups are named `workflow:<rootRunId>`. " +
		"Consider the expanded workflow topology and match each update's reach to its impact: send a local update to " +
		"its affected stage; when shared scope or acceptance criteria change, broadcast one authoritative Intercom update " +
		"to `workflow:<rootRunId>/**` (or a narrower path pattern such as `workflow:<rootRunId>/review-*`) rather than " +
		"enumerating stages, including each worker-to-reviewer loop. `**` reaches every live stage now and remains sticky " +
		"for every future stage, including nested children, until the root run terminates. Use `intercom list` inside the " +
		"invocation group to see live, pending, and possible future targets. Targets use " +
		"`workflow:<rootRunId>/<segment>[/<segment>...]`; `*` matches one segment and `**` any depth. Intercom delivers " +
		"immediately to live stages and queues updates for known stages that have not started, delivering them before their " +
		"first model turn, so workers and reviewers begin with one consistent contract. A valid target outside the known set " +
		"still queues and settles undeliverable at terminal only if never delivered; a note appears only when the target looks like a typo of a known stage. " +
		"Use `ask` once the target has a live session that can reply. " +
		"Use workflow pause, resume, or quit for run control. " +
		"Continue the progressing run when no intervention is needed, or ask the user when a decision is needed. " +
		`Inspect: /workflows ${details.runId}`
	);
}

export interface WorkflowHeartbeatRendererOptions {
	readonly registerMessageRenderer?: ExtensionAPI["registerMessageRenderer"];
	readonly rendererHost?: object;
}

export function registerWorkflowHeartbeatRenderer(options: WorkflowHeartbeatRendererOptions): void {
	const register = options.registerMessageRenderer;
	if (typeof register !== "function") return;

	const host = options.rendererHost ?? register;
	if (rendererRegisteredHosts.has(host)) return;

	const renderer: PiMessageRenderer = (raw, renderOptions) => {
		const message = raw as { details?: WorkflowHeartbeatEventDetails };
		if (!message.details) return undefined;
		return makeWorkflowHeartbeatComponent(
			message.details,
			renderOptions?.expanded === true,
			renderOptions?.outputPad,
		);
	};

	register(WORKFLOW_HEARTBEAT_CUSTOM_TYPE, renderer);
	rendererRegisteredHosts.add(host);
}

/**
 * The heartbeat in the shared notice anatomy: `♥ Workflow heartbeat · <name> still running · <elapsed>`, the run and
 * its cadence on the connector row, and where to inspect it. Expanded, each fact has a row of its own.
 */
export function workflowHeartbeatBlock(
	details: WorkflowHeartbeatEventDetails,
	expanded = false,
	outputPad?: number,
): HeartbeatBlock {
	const elapsed = formatWorkflowHeartbeatElapsed(details);
	const runId = inertDisplayLine(details.runId);
	const name = inertDisplayLine(details.workflowName);
	const cadence = `${formatWorkflowHeartbeatCadence(details.intervalMinutes)} cadence`;
	const records: HeartbeatRow[][] = expanded
		? [
				[
					{ text: `workflow ${name}`, wrap: true },
					{ text: `run ${runId}`, wrap: true },
					{ text: elapsed === undefined ? cadence : `${cadence} · running for ${elapsed}`, wrap: true },
				],
			]
		: [[`run ${runId} · ${cadence}`]];
	return new HeartbeatBlock({
		title: "Workflow heartbeat",
		subject: `${name} still running`,
		meta: elapsed === undefined ? [] : [elapsed],
		records,
		hint: `/workflows ${runId}`,
		expandable: true,
		expanded,
		...(outputPad === undefined ? {} : { outputPad }),
	});
}

function makeWorkflowHeartbeatComponent(
	details: WorkflowHeartbeatEventDetails,
	expanded: boolean,
	outputPad: number | undefined,
): PiMessageRenderComponent {
	const block = workflowHeartbeatBlock(details, expanded, outputPad);
	return {
		render(width: number): string[] {
			return block.render(width);
		},
		invalidate() {
			/* delivered heartbeats are immutable */
		},
	};
}

function formatWorkflowHeartbeatCadence(intervalMinutes: number): string {
	return `${intervalMinutes}-minute`;
}

/** Elapsed run time at the boundary, derived from the payload's own timestamps. */
function formatWorkflowHeartbeatElapsed(details: WorkflowHeartbeatEventDetails): string | undefined {
	const elapsedMs = details.scheduledAt - details.startedAt;
	if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return undefined;
	const totalMinutes = Math.floor(elapsedMs / 60_000);
	if (totalMinutes < 1) return `${Math.max(0, Math.floor(elapsedMs / 1000))}s`;
	if (totalMinutes < 60) return `${totalMinutes}m`;
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

function escapeQuotedText(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
