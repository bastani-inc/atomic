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
	noticeLabel?: string;
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

function isPromiseLike(value: unknown): value is PromiseLike<void> {
	return (typeof value === "object" || typeof value === "function")
		&& value !== null
		&& typeof (value as { then?: unknown }).then === "function";
}

async function dispatchFallback(
	pi: ExtensionAPI,
	prefix: TerminalPreludeMessage[],
	terminalMessage: TerminalPreludeMessage,
	deliveryOptions: Parameters<ExtensionAPI["sendMessage"]>[1],
): Promise<void> {
	let delivered = 0;
	try {
		for (const message of prefix) {
			await pi.sendMessage(message, { deliverAs: "steer" });
			delivered += 1;
		}
		await pi.sendMessage(terminalMessage, deliveryOptions);
	} catch (error) {
		const failure = new Error(error instanceof Error ? error.message : String(error), { cause: error });
		Object.assign(failure, { terminalPreludeDelivered: delivered });
		throw failure;
	}
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

	const emitTerminalOrderingBarrier = (result: SubagentResult, dispatch?: (prefix: TerminalPreludeMessage[]) => void | Promise<void>): Promise<void> | undefined => {
		const runId = result.runId ?? result.id;
		if (!runId) return undefined;
		const resultTargets = result.results?.map((child, arrayIndex) =>
			child.intercomTarget?.trim() || resolveSubagentIntercomTarget(runId, child.agent, child.index ?? arrayIndex)) ?? [];
		const sourceSessionTargets = resultTargets.length > 0
			? resultTargets
			: result.agent ? [resolveSubagentIntercomTarget(runId, result.agent, 0)] : [];
		if (sourceSessionTargets.length === 0) return undefined;
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
		Object.defineProperty(payload, "terminalOwner", { value: pi });
		pi.events.emit(SUBAGENT_TERMINAL_ORDERING_BARRIER_EVENT, payload);
		const globalHandler = (globalThis as Record<string, unknown>).__atomicTerminalOrderingBarrierHandler;
		if (typeof globalHandler === "function") (globalHandler as (value: unknown) => void)(payload);
		return (payload as typeof payload & { completion?: Promise<void> }).completion;
	};
	const inFlight = new Map<string, Promise<void>>();
	let registration: NotifyRegistration;
	const handleComplete = (data: unknown): void => {
		if (registry.get(pi) !== registration) return;
		const result = data as SubagentResult & Partial<CompletionNotificationEnvelope>;
		const now = Date.now();
		const key = result.notificationId ? `notification:${result.notificationId}` : buildCompletionKey(result, "notify");
		if (hasSeenWithTtl(seen, key, now, ttlMs)) {
			result.acknowledge?.(true);
			return;
		}
		const pending = inFlight.get(key);
		if (pending) {
			result.defer?.();
			void pending.then(() => result.acknowledge?.(true), () => result.acknowledge?.(false));
			return;
		}
		const ownership = Promise.withResolvers<void>();
		void ownership.promise.catch(() => {});
		inFlight.set(key, ownership.promise);
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
		const noticeLabel = typeof result.noticeLabel === "string" && result.noticeLabel.trim() ? result.noticeLabel.trim() : "Background task";
		const content = [
			`${noticeLabel} ${status}: **${agent}**${taskInfo}`,
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
		const deliveryOptions = { triggerTurn: true, stageAdmissionKey: `subagent:${key}` } as const;
		const succeed = (): void => {
			recordSeen(seen, key, Date.now());
			inFlight.delete(key);
			ownership.resolve();
			result.acknowledge?.(true);
		};
		const fail = (error: unknown): void => {
			inFlight.delete(key);
			ownership.reject(error);
			result.acknowledge?.(false);
			console.error("Failed to deliver async subagent completion notification:", error);
		};
		const observe = (delivery: PromiseLike<void>): void => {
			result.defer?.();
			void Promise.resolve(delivery).then(succeed, fail);
		};
		try {
			let dispatched = false;
			const barrierCompletion = emitTerminalOrderingBarrier(result, (prefix) => {
				dispatched = true;
				if (typeof pi.sendMessages === "function") {
					return pi.sendMessages([...prefix, terminalMessage], deliveryOptions);
				}
				return dispatchFallback(pi, prefix, terminalMessage, deliveryOptions);
			});
			if (barrierCompletion) {
				observe(barrierCompletion);
				return;
			}
			if (!dispatched) {
				const delivery = pi.sendMessage(terminalMessage, deliveryOptions);
				if (isPromiseLike(delivery)) {
					observe(delivery);
					return;
				}
			}
			succeed();
		} catch (error) {
			fail(error);
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
