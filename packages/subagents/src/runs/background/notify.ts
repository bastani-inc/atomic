/**
 * Subagent completion notifications.
 */

import type { ExtensionAPI } from "@bastani/atomic";
import { resolveSubagentIntercomTarget } from "../../intercom/intercom-bridge.ts";
import { buildCompletionKey, hasSeenWithTtl, recordSeen } from "./completion-dedupe.ts";
import type { CompletionNotificationEnvelope } from "./completion-notification.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT, SUBAGENT_TERMINAL_ORDERING_BARRIER_EVENT } from "../../shared/types.ts";

interface ChainStepResult {
	agent: string;
	output: string;
	success: boolean;
	intercomTarget?: string;
	index?: number;
}

export interface SubagentNotifyDetails {
	agent: string;
	status: "completed" | "failed" | "paused";
	taskInfo?: string;
	resultPreview: string;
	durationMs?: number;
	sessionLabel?: string;
	sessionValue?: string;
}

interface SubagentResult {
	id: string | null;
	runId?: string;
	notificationId?: string;
	agent: string | null;
	success: boolean;
	summary: string;
	exitCode?: number;
	state?: string;
	timestamp: number;
	durationMs?: number;
	sessionFile?: string;
	shareUrl?: string;
	gistUrl?: string;
	shareError?: string;
	results?: ChainStepResult[];
	taskIndex?: number;
	totalTasks?: number;
}

interface TerminalPreludeMessage {
	customType: string;
	content: string;
	display: boolean;
	details?: unknown;
}

interface NotifyRegistration {
	unsubscribe: () => void;
}

function getNotifyRegistry(): WeakMap<ExtensionAPI, NotifyRegistration> {
	const key = "__piSubagentsNotifyRegistrations";
	const store = globalThis as Record<string, unknown>;
	const existing = store[key];
	if (existing instanceof WeakMap) return existing as WeakMap<ExtensionAPI, NotifyRegistration>;
	const registry = new WeakMap<ExtensionAPI, NotifyRegistration>();
	store[key] = registry;
	return registry;
}

function getNotifySeenRegistry(): WeakMap<ExtensionAPI, Map<string, number>> {
	const key = "__piSubagentsNotifySeenByApi";
	const store = globalThis as Record<string, unknown>;
	const existing = store[key];
	if (existing instanceof WeakMap) return existing as WeakMap<ExtensionAPI, Map<string, number>>;
	const registry = new WeakMap<ExtensionAPI, Map<string, number>>();
	store[key] = registry;
	return registry;
}

function getNotifySeen(pi: ExtensionAPI): Map<string, number> {
	const registry = getNotifySeenRegistry();
	const existing = registry.get(pi);
	if (existing) return existing;
	const seen = new Map<string, number>();
	registry.set(pi, seen);
	return seen;
}

export default function registerSubagentNotify(pi: ExtensionAPI): () => void {
	const registry = getNotifyRegistry();
	const previous = registry.get(pi);
	if (previous) {
		try {
			previous.unsubscribe();
		} catch {
			// Best effort cleanup for stale handlers from an older reload.
		}
	}
	const seen = getNotifySeen(pi);
	const ttlMs = 10 * 60 * 1000;

	const emitTerminalOrderingBarrier = (result: SubagentResult, dispatch?: (prefix: TerminalPreludeMessage[]) => void): void => {
		const runId = result.runId ?? result.id;
		if (!runId) return;
		const resultTargets = result.results?.map((child, arrayIndex) =>
			child.intercomTarget?.trim() || resolveSubagentIntercomTarget(runId, child.agent, child.index ?? arrayIndex)) ?? [];
		const sourceSessionTargets = resultTargets.length > 0
			? resultTargets
			: result.agent ? [resolveSubagentIntercomTarget(runId, result.agent, 0)] : [];
		if (sourceSessionTargets.length === 0) return;
		const terminalId = result.notificationId?.startsWith("completion-notify-")
			? result.notificationId.slice("completion-notify-".length)
			: result.notificationId;
		const payload = {
			runId,
			...(terminalId ? { terminalId } : {}),
			terminalAt: Number.isFinite(result.timestamp) ? result.timestamp : Date.now(),
			source: "background-notify" as const,
			sourceSessionTargets,
			...(dispatch ? { dispatch } : {}),
		};
		pi.events.emit(SUBAGENT_TERMINAL_ORDERING_BARRIER_EVENT, payload);
		const globalHandler = (globalThis as Record<string, unknown>).__atomicTerminalOrderingBarrierHandler;
		if (typeof globalHandler === "function") (globalHandler as (value: unknown) => void)(payload);
	};
	let registration: NotifyRegistration;
	const handleComplete = (data: unknown) => {
		if (registry.get(pi) !== registration) return;
		const result = data as SubagentResult & Partial<CompletionNotificationEnvelope>;
		const now = Date.now();
		const key = result.notificationId ? `notification:${result.notificationId}` : buildCompletionKey(result, "notify");
		if (hasSeenWithTtl(seen, key, now, ttlMs)) {
			result.acknowledge?.(true);
			return;
		}
		const agent = result.agent ?? "unknown";
		const summary = typeof result.summary === "string" ? result.summary : "";
		const paused = !result.success && (
			result.exitCode === 0
			|| result.state === "paused"
			|| summary.startsWith("Paused after interrupt.")
		);
		const status = paused ? "paused" : result.success ? "completed" : "failed";

		const taskInfo =
			result.taskIndex !== undefined && result.totalTasks !== undefined
				? ` (${result.taskIndex + 1}/${result.totalTasks})`
				: "";

		const sessionLine = result.shareUrl
			? `Session: ${result.shareUrl}`
			: result.shareError
				? `Session share error: ${result.shareError}`
				: result.sessionFile
					? `Session file: ${result.sessionFile}`
					: undefined;

		const displaySummary = summary.trim() ? summary : "(no output)";
		const content = [
			`Background task ${status}: **${agent}**${taskInfo}`,
			"",
			displaySummary,
			sessionLine ? "" : undefined,
			sessionLine,
		]
			.filter((line) => line !== undefined)
			.join("\n");

		const terminalMessage = {
			customType: "subagent-notify",
			content,
			display: true,
		};
		try {
			let dispatched = false;
			emitTerminalOrderingBarrier(result, (prefix) => {
				if (typeof pi.sendMessages === "function") {
					pi.sendMessages([...prefix, terminalMessage], { triggerTurn: true });
				} else {
					for (const message of prefix) pi.sendMessage(message, { deliverAs: "steer" });
					pi.sendMessage(terminalMessage, { triggerTurn: true });
				}
				dispatched = true;
			});
			if (!dispatched) pi.sendMessage(terminalMessage, { triggerTurn: true });
			recordSeen(seen, key, Date.now());
			result.acknowledge?.(true);
		} catch (error) {
			result.acknowledge?.(false);
			console.error("Failed to deliver async subagent completion notification:", error);
		}
	};

	const unsubscribe = pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, handleComplete);
	registration = { unsubscribe };
	registry.set(pi, registration);
	return () => {
		if (registry.get(pi) !== registration) return;
		registry.delete(pi);
		unsubscribe();
	};
}
