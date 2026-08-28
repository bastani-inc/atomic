import {
	WORKFLOW_HEARTBEAT_CUSTOM_TYPE,
	type WorkflowHeartbeatEventDetails,
} from "../shared/workflow-heartbeat-contract.js";
import { deriveGraphThemeFromPiTheme, type GraphTheme } from "../tui/graph-theme.js";
import { renderWorkflowNoticeCard } from "../tui/workflow-notice-card.js";
import type { ExtensionAPI, PiMessageRenderComponent, PiMessageRenderer } from "./index.js";

/** Card title and glyph, both distinct from every lifecycle notice kind. */
const WORKFLOW_HEARTBEAT_TITLE = "WORKFLOW HEARTBEAT";
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
		"When steering or communication is useful, use Intercom. Consider the expanded workflow topology and match " +
		"each update's reach to its impact: send a local update to its affected stage; when shared scope or acceptance " +
		"criteria change, send the same authoritative Intercom update to every relevant live and known unstarted " +
		"`<runId>:<stageKey>`, including each worker-to-reviewer loop. Intercom delivers immediately to live stages and " +
		"queues updates for known stages that have not started, delivering them before their first model turn, so workers " +
		"and reviewers begin with one consistent contract. " +
		"Use `ask` once the target has a live session that can reply. " +
		"Use workflow pause, resume, interrupt, or quit for run control. " +
		"Continue the progressing run when no intervention is needed, or ask the user when a decision is needed. " +
		`Inspect: /workflow status ${details.runId}`
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

	const renderer: PiMessageRenderer = (raw, _options, piTheme) => {
		const message = raw as { details?: WorkflowHeartbeatEventDetails };
		if (!message.details) return undefined;
		return makeWorkflowHeartbeatComponent(message.details, themeFromRenderer(piTheme));
	};

	register(WORKFLOW_HEARTBEAT_CUSTOM_TYPE, renderer);
	rendererRegisteredHosts.add(host);
}

function makeWorkflowHeartbeatComponent(
	details: WorkflowHeartbeatEventDetails,
	theme: GraphTheme | undefined,
): PiMessageRenderComponent {
	const text = formatWorkflowHeartbeatNoticeText(details);
	return {
		render(width: number): string[] {
			return renderWorkflowHeartbeatCard(details, { width, theme, fallbackText: text });
		},
		invalidate() {
			/* delivered heartbeats are immutable */
		},
	};
}

function renderWorkflowHeartbeatCard(
	details: WorkflowHeartbeatEventDetails,
	opts: { width: number; theme?: GraphTheme; fallbackText: string },
): string[] {
	return renderWorkflowNoticeCard({
		title: WORKFLOW_HEARTBEAT_TITLE,
		glyph: WORKFLOW_HEARTBEAT_GLYPH,
		headline: `Workflow "${details.workflowName}" is still running`,
		tone: "mauve",
		fields: [
			{ label: "workflow", value: details.workflowName },
			{ label: "run", value: details.runId },
			{ label: "cadence", value: formatWorkflowHeartbeatCadence(details.intervalMinutes), tone: "muted" },
			{ label: "elapsed", value: formatWorkflowHeartbeatElapsed(details), tone: "muted" },
		],
		hints: [`/workflow status ${details.runId}`],
		fallbackText: opts.fallbackText,
		width: opts.width,
		...(opts.theme ? { theme: opts.theme } : {}),
	});
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

function themeFromRenderer(piTheme: unknown): GraphTheme | undefined {
	return piTheme === undefined ? undefined : deriveGraphThemeFromPiTheme(piTheme);
}
