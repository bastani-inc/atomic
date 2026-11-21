import { randomUUID } from "node:crypto";
import { isStaleExtensionContextError } from "@bastani/atomic";
import {
	existingArtifactPath,
	PARENT_CANCEL_CAUSE,
	presentCancelledStatus,
} from "../runs/shared/cancellation-recovery.js";
import {
	type Details,
	type IntercomEventBus,
	type SingleResult,
	SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT,
	SUBAGENT_RESULT_INTERCOM_EVENT,
	type SubagentAttemptStatus,
	type SubagentResultIntercomChild,
	type SubagentResultIntercomPayload,
	type SubagentResultStatus,
	type SubagentRunMode,
} from "../shared/types.js";

export function resolveSubagentResultStatus(input: {
	status?: SubagentAttemptStatus;
	success?: boolean;
	state?: string;
	interrupted?: boolean;
	detached?: boolean;
}): SubagentResultStatus {
	if (input.status === "killed" || input.state === "killed") return "killed";
	if (input.detached || input.status === "continued") return "detached";
	if (input.interrupted || input.status === "interrupted" || input.state === "interrupted") return "interrupted";
	if (input.status === "ok" || input.success === true || input.state === "complete") return "completed";
	if (input.status === "error" || input.status === "skipped" || input.success === false || input.state === "failed")
		return "failed";
	return "failed";
}

function countStatuses(children: SubagentResultIntercomChild[]): Record<SubagentResultStatus, number> {
	const counts: Record<SubagentResultStatus, number> = {
		completed: 0,
		failed: 0,
		interrupted: 0,
		killed: 0,
		detached: 0,
	};
	for (const child of children) {
		counts[child.status] += 1;
	}
	return counts;
}

function formatStatusCounts(children: SubagentResultIntercomChild[]): string {
	let completed = 0;
	let failed = 0;
	let interrupted = 0;
	let killed = 0;
	let cancelled = 0;
	let detached = 0;
	for (const child of children) {
		const label = presentCancelledStatus(child.status, child.cause);
		if (label === "cancelled") cancelled += 1;
		else if (label === "completed") completed += 1;
		else if (label === "failed") failed += 1;
		else if (label === "interrupted") interrupted += 1;
		else if (label === "killed") killed += 1;
		else if (label === "detached") detached += 1;
	}
	const parts = [
		completed ? `${completed} completed` : undefined,
		failed ? `${failed} failed` : undefined,
		cancelled ? `${cancelled} cancelled` : undefined,
		interrupted ? `${interrupted} interrupted` : undefined,
		killed ? `${killed} killed (non-resumable)` : undefined,
		detached ? `${detached} detached` : undefined,
	].filter((part): part is string => Boolean(part));
	return parts.length ? parts.join(", ") : "0 results";
}

function resolveGroupedStatus(children: SubagentResultIntercomChild[]): SubagentResultStatus {
	const counts = countStatuses(children);
	if (counts.failed > 0) return "failed";
	if (groupedParentCancelCause(children)) return "interrupted";
	if (counts.killed > 0) return "killed";
	if (counts.interrupted > 0) return "interrupted";
	if (counts.completed > 0) return "completed";
	if (counts.detached > 0) return "detached";
	return "failed";
}

async function citedChildPath(
	child: SubagentResultIntercomChild,
	pathValue: string | undefined,
): Promise<string | undefined> {
	if (presentCancelledStatus(child.status, child.cause) !== "cancelled") return pathValue;
	return existingArtifactPath(pathValue);
}

/** A child's session as cited: its session file while it exists, or its history URL, a session in the store. */
function citedChildSession(child: SubagentResultIntercomChild): Promise<string | undefined> {
	return child.sessionPath !== undefined && child.sessionPath === child.sessionUrl
		? Promise.resolve(child.sessionUrl)
		: citedChildPath(child, child.sessionPath);
}

export interface GroupedResultIntercomMessageInput {
	to: string;
	runId: string;
	mode: SubagentRunMode;
	children: SubagentResultIntercomChild[];
}

function groupedParentCancelCause(children: SubagentResultIntercomChild[]): string | undefined {
	if (children.length === 0) return undefined;
	const labels = children.map((child) => presentCancelledStatus(child.status, child.cause));
	if (labels.some((label) => label === "cancelled") && !labels.some((label) => label === "interrupted")) {
		return PARENT_CANCEL_CAUSE;
	}
	return undefined;
}

async function formatSubagentResultIntercomMessage(input: {
	runId: string;
	mode: SubagentRunMode;
	status: SubagentResultStatus;
	children: SubagentResultIntercomChild[];
}): Promise<string> {
	const lines: string[] = [
		"subagent results",
		"",
		`Run: ${input.runId}`,
		`Mode: ${input.mode}`,
		`Status: ${presentCancelledStatus(input.status, groupedParentCancelCause(input.children))}`,
		`Children: ${formatStatusCounts(input.children)}`,
	];
	if (input.children.some((child) => child.intercomTarget)) {
		lines.push(
			"",
			"Intercom targets below identify child sessions used while they were running; completed child sessions may no longer be reachable. Inspect artifacts or session logs for follow-up.",
		);
	}

	for (let index = 0; index < input.children.length; index++) {
		const child = input.children[index]!;
		lines.push("", `${index + 1}. ${child.agent} — ${presentCancelledStatus(child.status, child.cause)}`);
		if (child.intercomTarget) lines.push(`Run intercom target: ${child.intercomTarget}`);
		if (await citedChildPath(child, child.artifactPath)) lines.push(`Output artifact: ${child.artifactPath}`);
		if (await citedChildSession(child)) lines.push(`Session: ${child.sessionPath}`);
		lines.push("Summary:", child.summary);
	}

	return lines.join("\n");
}

export async function buildSubagentResultIntercomPayload(
	input: GroupedResultIntercomMessageInput,
): Promise<SubagentResultIntercomPayload> {
	const children = input.children.map((child) => ({
		...child,
		summary: child.summary.trim() || "(no output)",
	}));
	const status = resolveGroupedStatus(children);
	const summary = formatStatusCounts(children);
	const firstChild = children[0];
	const payload: SubagentResultIntercomPayload = {
		to: input.to,
		runId: input.runId,
		mode: input.mode,
		status,
		summary,
		children,
		...(firstChild?.agent ? { agent: firstChild.agent } : {}),
		...(firstChild?.index !== undefined ? { index: firstChild.index } : {}),
		...(firstChild?.artifactPath ? { artifactPath: firstChild.artifactPath } : {}),
		...(firstChild?.sessionPath ? { sessionPath: firstChild.sessionPath } : {}),
		message: "",
	};
	payload.message = await formatSubagentResultIntercomMessage(payload);
	return payload;
}

/**
 * How the relay settled a result: `delivered` and `unconfirmed` both mean the relay owns the result (an unconfirmed
 * send may still arrive), so the caller must not also return it inline; only `undelivered` leaves it to the caller.
 */
export type SubagentIntercomDelivery = "delivered" | "unconfirmed" | "undelivered";

/** Once the relay has started delivering, how long to wait for its answer before reporting the delivery unconfirmed. */
export const RESULT_RELAY_COMMITTED_TIMEOUT_MS = 30_000;

export async function deliverSubagentResultIntercomEvent(
	events: IntercomEventBus,
	payload: SubagentResultIntercomPayload,
	timeoutMs: number | false = 500,
): Promise<SubagentIntercomDelivery> {
	return deliverSubagentIntercomMessageEvent(
		events,
		payload.to,
		payload.message,
		timeoutMs,
		payload as unknown as Record<string, unknown>,
	);
}

export async function deliverSubagentIntercomMessageEvent(
	events: IntercomEventBus,
	to: string,
	message: string,
	timeoutMs: number | false = 500,
	extra: Record<string, unknown> = {},
): Promise<SubagentIntercomDelivery> {
	if (typeof events.on !== "function" || typeof events.emit !== "function") return "undelivered";
	const requestId = typeof extra.requestId === "string" ? extra.requestId : randomUUID();
	return new Promise((resolve) => {
		let settled = false;
		let unsubscribe: (() => void) | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		// Exactly one side delivers the result (#5018): the relay claims it right before dispatching, and a
		// deadline that passes before that claim takes it back for the inline tool result, so the relay drops it.
		let owner: "pending" | "relay" | "inline" = "pending";
		const claimDelivery = (): boolean => {
			if (owner === "inline") return false;
			owner = "relay";
			return true;
		};
		const takeInline = (): boolean => {
			if (owner === "relay") return false;
			owner = "inline";
			return true;
		};
		const finish = (delivered: SubagentIntercomDelivery) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			try {
				unsubscribe?.();
			} catch (error) {
				if (!isStaleExtensionContextError(error)) throw error;
				// Stale event-bus cleanup must not change the delivery result.
			}
			resolve(delivered);
		};
		try {
			unsubscribe = events.on(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, (data) => {
				if (!data || typeof data !== "object") return;
				const delivery = data as { requestId?: unknown; delivered?: unknown; unconfirmed?: unknown };
				if (delivery.requestId !== requestId) return;
				finish(
					delivery.delivered === true
						? "delivered"
						: delivery.unconfirmed === true
							? "unconfirmed"
							: "undelivered",
				);
			});
		} catch (error) {
			if (!isStaleExtensionContextError(error)) throw error;
			finish("undelivered");
			return;
		}
		if (timeoutMs !== false) {
			timer = setTimeout(() => {
				if (takeInline()) {
					finish("undelivered");
					return;
				}
				timer = setTimeout(() => finish("unconfirmed"), RESULT_RELAY_COMMITTED_TIMEOUT_MS);
			}, timeoutMs);
		}
		try {
			events.emit(SUBAGENT_RESULT_INTERCOM_EVENT, { ...extra, to, message, requestId, claimDelivery });
		} catch {
			finish(takeInline() ? "undelivered" : "unconfirmed");
		}
	});
}

function stripSingleResultOutputs(result: SingleResult): SingleResult {
	return {
		...result,
		messages: undefined,
		finalOutput: undefined,
		truncation: undefined,
	};
}

export function stripDetailsOutputsForIntercomReceipt(details: Details): Details {
	return {
		...details,
		results: details.results.map(stripSingleResultOutputs),
	};
}

export async function formatSubagentResultReceipt(input: {
	mode: SubagentRunMode;
	runId: string;
	payload: SubagentResultIntercomPayload;
	/** False when the relay took the result but could not confirm it arrived. */
	confirmed?: boolean;
}): Promise<string> {
	const modeLabel = input.mode === "single" ? "single subagent result" : "parallel subagent results";
	const confirmed = input.confirmed !== false;
	const lines = [
		confirmed
			? `Delivered ${modeLabel} via intercom.`
			: `Sent ${modeLabel} via intercom; delivery was not confirmed.`,
		`Run: ${input.runId}`,
		`Children: ${formatStatusCounts(input.payload.children)}`,
	];

	const artifacts: SubagentResultIntercomChild[] = [];
	for (const child of input.payload.children) {
		if (await citedChildPath(child, child.artifactPath)) artifacts.push(child);
	}
	if (artifacts.length > 0) {
		lines.push("Artifacts:");
		for (const child of artifacts) {
			lines.push(`- ${child.agent} [${presentCancelledStatus(child.status, child.cause)}]: ${child.artifactPath}`);
		}
	}

	const intercomTargets = input.payload.children.filter((child) => typeof child.intercomTarget === "string");
	if (intercomTargets.length > 0) {
		lines.push("Run intercom targets (may be inactive after completion):");
		for (const child of intercomTargets) {
			lines.push(`- ${child.agent} [${presentCancelledStatus(child.status, child.cause)}]: ${child.intercomTarget}`);
		}
	}

	const sessions: SubagentResultIntercomChild[] = [];
	for (const child of input.payload.children) {
		if (await citedChildSession(child)) sessions.push(child);
	}
	if (sessions.length > 0) {
		lines.push("Sessions:");
		for (const child of sessions) {
			lines.push(`- ${child.agent} [${presentCancelledStatus(child.status, child.cause)}]: ${child.sessionPath}`);
		}
	}

	lines.push(
		confirmed
			? "Full grouped output was sent over intercom."
			: "Full grouped output was sent over intercom; if it does not arrive, read the artifacts or sessions above.",
	);
	return lines.join("\n");
}
