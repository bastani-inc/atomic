import { randomUUID } from "node:crypto";
import { createEventBus, getBuiltinPackagePaths } from "@bastani/atomic";
import {
	IntercomClient,
	type PendingStageMessageRequest,
	type PendingStageMessageResult,
	type StickyLiveDeliveredNotice,
} from "./broker/client.js";
import { spawnBrokerIfNeeded } from "./broker/spawn.js";
import { loadConfig } from "./config.js";
import { jitteredReconnectDelayMs } from "./reconnect-backoff.js";
import { createConcurrencyGate, ROUTE_CLIENT_CONNECT_CONCURRENCY } from "./route-connect-gate.js";
import type {
	WorkflowPossibleStageAnnouncement,
	WorkflowRunParentAnnouncement,
	WorkflowStageRosterAnnouncement,
} from "./types.js";

interface Route {
	readonly runId: string;
	readonly group: string;
	readonly capability: string;
	readonly stages?: WorkflowStageRosterAnnouncement[];
	readonly possibleStages?: WorkflowPossibleStageAnnouncement[];
	readonly parent?: WorkflowRunParentAnnouncement;
	completion?: Promise<void>;
}

interface RouteState {
	route: Route;
	client?: IntercomClient;
	tail: Promise<void>;
	retry?: ReturnType<typeof setTimeout>;
	attempt: number;
	closed: boolean;
}

interface PendingMessage extends PendingStageMessageRequest {
	handled: boolean;
	completion?: Promise<PendingStageMessageResult>;
}

interface Undeliverable {
	handled: boolean;
	completion?: Promise<boolean>;
	readonly runId: string;
	readonly senderId: string;
	readonly senderRegistrationName?: string;
	readonly senderReturnAddress?: string;
	readonly messageId: string;
	readonly notificationId: string;
	readonly reason: string;
}

export function createWorkflowRouteOwner(cwd: string) {
	const events = createEventBus();
	const config = loadConfig();
	const id = randomUUID();
	const routes = new Map<string, RouteState>();
	const gate = createConcurrencyGate(ROUTE_CLIENT_CONNECT_CONCURRENCY);

	function scheduleRetry(state: RouteState): void {
		if (state.closed || state.retry !== undefined) return;
		state.retry = setTimeout(
			() => {
				state.retry = undefined;
				void publish(state, state.route).catch(() => scheduleRetry(state));
			},
			jitteredReconnectDelayMs(state.attempt++),
		);
		state.retry.unref();
	}

	async function connect(state: RouteState): Promise<IntercomClient> {
		if (state.client?.isConnected()) return state.client;
		const [extensionDir] = getBuiltinPackagePaths({
			workflows: false,
			subagents: false,
			mcp: false,
			"web-access": false,
		});
		if (extensionDir === undefined) throw new Error("Intercom builtin package is unavailable");
		await spawnBrokerIfNeeded(config.brokerCommand, config.brokerArgs, undefined, extensionDir);
		if (state.closed) throw new Error("Workflow Intercom route owner closed");
		const client = new IntercomClient(`${id}:pending-stage-route:${state.route.runId}`);
		state.client = client;
		client.on("error", () => {});
		client.on("disconnected", () => {
			if (state.client !== client) return;
			state.client = undefined;
			scheduleRetry(state);
		});
		client.on("pending_stage_message", (request: PendingStageMessageRequest) => {
			if (state.closed || state.client !== client) return;
			const event: PendingMessage = { ...request, handled: false };
			events.emit("atomic:workflow-pending-stage-message", event);
			const completion =
				event.handled && event.completion !== undefined
					? event.completion
					: Promise.resolve<PendingStageMessageResult>({ outcome: "refused", reason: "Session not found" });
			void completion
				.catch((error: Error): PendingStageMessageResult => ({ outcome: "refused", reason: error.message }))
				.then((result) => client.respondPendingStageMessage(request.requestId, result))
				.catch(() => {});
		});
		client.on("sticky_live_delivered", (notice: StickyLiveDeliveredNotice) => {
			if (state.closed || state.client !== client) return;
			events.emit("atomic:workflow-sticky-live-delivered", { ...notice, handled: false });
		});
		await client.connect({
			cwd,
			model: "workflow",
			pid: process.pid,
			startedAt: Date.now(),
			lastActivity: Date.now(),
			group: state.route.group,
			groups: [state.route.group],
			recipientPurpose: "control",
		});
		return client;
	}

	function publish(state: RouteState, route: Route): Promise<void> {
		const completion = state.tail
			.catch(() => {})
			.then(() =>
				gate.run(async () => {
					if (state.closed) throw new Error("Workflow Intercom route owner closed");
					const establishedClient = state.client?.isConnected() ? state.client : undefined;
					try {
						const client = await connect(state);
						await client.registerPendingStageRouteAcknowledged(
							route.runId,
							route.group,
							route.capability,
							route.stages,
							route.possibleStages,
							route.parent,
						);
						state.attempt = 0;
						clearTimeout(state.retry);
						state.retry = undefined;
					} catch (error) {
						const client = state.client;
						if (client !== establishedClient || !client?.isConnected()) {
							state.client = undefined;
							await client?.disconnect();
						}
						scheduleRetry(state);
						throw error;
					}
				}),
			);
		state.tail = completion;
		void completion.catch(() => {});
		return completion;
	}

	events.on("atomic:workflow-pending-stage-route", (payload) => {
		const route = payload as Route;
		let state = routes.get(route.runId);
		if (state === undefined) {
			state = { route, tail: Promise.resolve(), attempt: 0, closed: false };
			routes.set(route.runId, state);
		}
		state.route = route;
		route.completion = publish(state, route);
	});
	events.on("atomic:workflow-pending-stage-undeliverable", (payload) => {
		const event = payload as Undeliverable;
		const state = routes.get(event.runId);
		if (state === undefined || event.handled) return;
		event.handled = true;
		event.completion = (async () => {
			await publish(state, state.route);
			const client = state.client;
			if (client === undefined || !client.isConnected()) return false;
			const text = `Pending workflow stage could not receive intercom message: ${event.reason}`;
			const result = await client.sendPendingStageNotification(
				event.runId,
				state.route.capability,
				event.senderId,
				event.senderRegistrationName,
				{ text, replyTo: event.messageId, replyError: text, messageId: event.notificationId },
				event.senderReturnAddress,
			);
			return result.delivered;
		})().catch(() => false);
	});

	return {
		events,
		async closeGroup(group: string): Promise<void> {
			const closing = [...routes.values()].filter((state) => state.route.group === group);
			for (const state of closing) {
				state.closed = true;
				clearTimeout(state.retry);
				routes.delete(state.route.runId);
			}
			await Promise.all(
				closing.map(async (state) => {
					await state.client?.disconnect();
					await state.tail.catch(() => {});
					await state.client?.disconnect();
				}),
			);
		},
	};
}
