import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { APP_NAME, getEnvValue } from "@bastani/atomic";
import type { ExtensionAPI, ToolDefinition } from "@bastani/atomic";

import { discoverAgents } from "../agents/agents.ts";
import { resolveSubagentIntercomTarget } from "../intercom/intercom-bridge.ts";
import { deliverSubagentIntercomMessageEvent } from "../intercom/result-intercom.ts";
import { createSubagentExecutor } from "../runs/foreground/subagent-executor.ts";
import { readNestedControlRequests, resolveNestedRouteFromEnv, writeNestedControlResult, type NestedRoute } from "../runs/shared/nested-events.ts";
import { SUBAGENT_CHILD_ENV, SUBAGENT_FANOUT_CHILD_ENV } from "../runs/shared/pi-args.ts";
import { getArtifactsDir } from "../shared/artifacts.ts";
import { type Details, type SubagentState } from "../shared/types.ts";
import { loadConfig } from "./config.ts";
import { createProgrammaticSubagentToolEntrypoint } from "./programmatic-tool.ts";
import { SubagentParams } from "./schemas.ts";

function getSubagentSessionRoot(parentSessionFile: string | null): string {
	if (parentSessionFile) {
		const baseName = path.basename(parentSessionFile, ".jsonl");
		const sessionsDir = path.dirname(parentSessionFile);
		return path.join(sessionsDir, baseName);
	}
	return fs.mkdtempSync(path.join(os.tmpdir(), `${APP_NAME}-subagent-session-`));
}

function expandTilde(p: string): string {
	return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

export function createChildSafeState(): SubagentState {
	return {
		baseCwd: "",
		currentSessionId: null,
		asyncJobs: new Map(),
		subagentInProgress: false,
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(),
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		// Child-safe stub: the parent extension owns watcher/coalescer/cleanup state.
		resultFileCoalescer: {
			schedule: () => false,
			clear: () => {},
		},
	};
}

const MAX_SEEN_REQUEST_IDS = 1024;
const TRIMMED_SEEN_REQUEST_IDS = 512;
const MAX_PENDING_RESULTS = 256;
const MAX_PENDING_RESULT_ATTEMPTS = 10;
const MAX_PENDING_RESULT_AGE_MS = 60_000;
const NESTED_CONTROL_INBOX_TIMER_KEY = "fanout-child:nested-control-inbox";

type NestedControlResultPayload = Parameters<typeof writeNestedControlResult>[1];

interface PendingControlResult {
	result: NestedControlResultPayload;
	firstFailureAt: number;
	attempts: number;
}

function rememberSeenRequest(seen: Set<string>, requestId: string): void {
	seen.add(requestId);
	if (seen.size <= MAX_SEEN_REQUEST_IDS) return;
	const keep = [...seen].slice(-TRIMMED_SEEN_REQUEST_IDS);
	seen.clear();
	for (const id of keep) seen.add(id);
}

function dropControlRequestFile(filePath: string, requestId: string): void {
	try {
		fs.unlinkSync(filePath);
	} catch (error) {
		console.error(`Failed to remove processed nested control request '${requestId}' at '${filePath}':`, error);
	}
}

function shouldDropPendingResult(pending: PendingControlResult, pendingSize: number, now: number): boolean {
	return pending.attempts >= MAX_PENDING_RESULT_ATTEMPTS
		|| now - pending.firstFailureAt >= MAX_PENDING_RESULT_AGE_MS
		|| pendingSize > MAX_PENDING_RESULTS;
}

function buildNestedControlResult(
	pi: ExtensionAPI,
	state: SubagentState,
	request: ReturnType<typeof readNestedControlRequests>[number],
): Promise<NestedControlResultPayload> {
	return (async () => {
		let ok = false;
		let message = "Control request failed.";
		try {
			const control = state.foregroundControls.get(request.targetRunId);
			if (!control) {
				message = `Nested run ${request.targetRunId} is not active in this fanout child.`;
			} else if (request.action === "interrupt") {
				ok = control.interrupt?.() === true;
				message = ok
					? `Interrupt requested for nested run ${request.targetRunId}.`
					: `Nested run ${request.targetRunId} has no active child step to interrupt.`;
			} else if (!request.message?.trim()) {
				message = "Nested resume requires message.";
			} else if (!control.currentAgent) {
				message = `Nested run ${request.targetRunId} has no active child message route.`;
			} else {
				const index = control.currentIndex ?? 0;
				const target = resolveSubagentIntercomTarget(request.targetRunId, control.currentAgent, index);
				ok = await deliverSubagentIntercomMessageEvent(
					pi.events,
					target,
					`Follow-up for nested run ${request.targetRunId} (${control.currentAgent}):\n\n${request.message.trim()}`,
					500,
					{ source: "nested-resume", runId: request.targetRunId, agent: control.currentAgent, index },
				);
				message = ok
					? `Delivered follow-up to live nested run ${request.targetRunId}.`
					: `Nested child intercom target is not registered: ${target}`;
			}
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		return { ts: Date.now(), requestId: request.requestId, targetRunId: request.targetRunId, ok, message };
	})();
}

export function startNestedControlInboxListener(pi: ExtensionAPI, state: SubagentState): NodeJS.Timeout | undefined {
	let route: NestedRoute | undefined;
	try {
		route = resolveNestedRouteFromEnv();
	} catch {
		return undefined;
	}
	if (!route) return undefined;
	const seen = new Set<string>();
	const inFlight = new Set<string>();
	const pendingResults = new Map<string, PendingControlResult>();
	const timer = setInterval(() => {
		try {
			for (const request of readNestedControlRequests(route)) {
				if (seen.has(request.requestId) || inFlight.has(request.requestId)) continue;
				inFlight.add(request.requestId);
				void (async () => {
					try {
						const pending = pendingResults.get(request.requestId);
						const result = pending?.result ?? await buildNestedControlResult(pi, state, request);
						try {
							writeNestedControlResult(route, result);
						} catch (error) {
							const now = Date.now();
							const nextPending: PendingControlResult = {
								result,
								firstFailureAt: pending?.firstFailureAt ?? now,
								attempts: (pending?.attempts ?? 0) + 1,
							};
							pendingResults.set(request.requestId, nextPending);
							if (shouldDropPendingResult(nextPending, pendingResults.size, now)) {
								pendingResults.delete(request.requestId);
								rememberSeenRequest(seen, request.requestId);
								dropControlRequestFile(request.filePath, request.requestId);
								console.error(`Dropping nested control result for request '${request.requestId}' targeting '${request.targetRunId}' after ${nextPending.attempts} failed write attempts via inbox '${route.controlInbox}':`, error);
							} else if (nextPending.attempts === 1) {
								console.error(`Failed to write nested control result for request '${request.requestId}' targeting '${request.targetRunId}' via inbox '${route.controlInbox}'; keeping request for retry:`, error);
							}
							return;
						}
						pendingResults.delete(request.requestId);
						rememberSeenRequest(seen, request.requestId);
						dropControlRequestFile(request.filePath, request.requestId);
					} finally {
						inFlight.delete(request.requestId);
					}
				})();
			}
		} catch (error) {
			console.error(`Failed to poll nested control inbox '${route.controlInbox}' for root '${route.rootRunId}':`, error);
		}
	}, 200);
	timer.unref?.();
	state.cleanupTimers.set(NESTED_CONTROL_INBOX_TIMER_KEY, timer);
	return timer;
}

export default function registerFanoutChildSubagentExtension(pi: ExtensionAPI): void {
	if (getEnvValue(SUBAGENT_CHILD_ENV) !== "1" || getEnvValue(SUBAGENT_FANOUT_CHILD_ENV) !== "1") return;

	const globalStore = globalThis as Record<string, unknown>;
	const registeredKey = "__atomicSubagentFanoutChildRegisteredApis";
	const cleanupKey = "__atomicSubagentFanoutChildRuntimeCleanup";
	const registeredApis = globalStore[registeredKey] instanceof WeakSet
		? globalStore[registeredKey] as WeakSet<ExtensionAPI>
		: new WeakSet<ExtensionAPI>();
	globalStore[registeredKey] = registeredApis;
	if (registeredApis.has(pi)) return;
	const previousRuntimeCleanup = globalStore[cleanupKey];
	if (typeof previousRuntimeCleanup === "function") {
		try {
			previousRuntimeCleanup();
		} catch {
			// Best effort cleanup for stale fanout-child timers from an older reload.
		}
	}
	registeredApis.add(pi);

	const config = loadConfig();
	const state = createChildSafeState();
	const executor = createSubagentExecutor({
		pi,
		state,
		config,
		asyncByDefault: config.asyncByDefault === true,
		tempArtifactsDir: getArtifactsDir(null),
		getSubagentSessionRoot,
		expandTilde,
		discoverAgents,
		allowMutatingManagementActions: false,
	});

	const programmaticEntrypoint = createProgrammaticSubagentToolEntrypoint(executor.execute);
	const tool: ToolDefinition<typeof SubagentParams, Details> = {
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate to subagents from child-safe fanout mode.",
			"Execution calls always start non-interactively.",
			"Allowed management/control actions: list, get, status, interrupt, resume, doctor.",
			"Agent config mutation actions create, update, and delete are blocked in this mode.",
		].join("\n"),
		parameters: SubagentParams,
		...programmaticEntrypoint,
	};

	pi.registerTool(tool);
	startNestedControlInboxListener(pi, state);
	globalStore[cleanupKey] = () => {
		for (const timer of state.cleanupTimers.values()) clearInterval(timer);
		state.cleanupTimers.clear();
	};
}
