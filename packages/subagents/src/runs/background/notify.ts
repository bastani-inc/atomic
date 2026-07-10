/**
 * Subagent completion notifications.
 */

import type { ExtensionAPI } from "@bastani/atomic";
import { buildCompletionKey, markSeenWithTtl } from "./completion-dedupe.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT } from "../../shared/types.ts";

interface ChainStepResult {
	agent: string;
	output: string;
	success: boolean;
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

	let registration: NotifyRegistration;
	const handleComplete = (data: unknown) => {
		if (registry.get(pi) !== registration) return;
		const result = data as SubagentResult;
		const now = Date.now();
		const key = buildCompletionKey(result, "notify");
		if (markSeenWithTtl(seen, key, now, ttlMs)) return;

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

		pi.sendMessage(
			{
				customType: "subagent-notify",
				content,
				display: true,
			},
			{ triggerTurn: true },
		);
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
