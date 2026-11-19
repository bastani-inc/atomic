import { randomUUID } from "node:crypto";
import { createEventBus, getBuiltinPackagePaths } from "@bastani/atomic";
import {
	IntercomClient,
	IntercomPendingStageRouteRefusedError,
	type PendingStageMessageRequest,
	type PendingStageMessageResult,
	type StickyLiveDeliveredNotice,
} from "./broker/client.js";
import { spawnBrokerIfNeeded } from "./broker/spawn.js";
import { loadConfig } from "./config.js";
import { jitteredReconnectDelayMs } from "./reconnect-backoff.js";
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
	tail: Promise<void>;
	retry?: ReturnType<typeof setTimeout>;
	attempt: number;
	/** The broker acknowledged this run's route on its connection's current client. */
	registered: boolean;
	/**
	 * The broker refused this run's route, so it has a connection of its own and cannot end its group's. It stays there
	 * once registered, until the run is retired: back on the group's connection, a later refusal would end that again.
	 */
	isolated: boolean;
	readonly waiters: Set<(registered: boolean) => void>;
}

/**
 * One broker connection per invocation group, shared by the routes of every run in it (#3904), keyed by the group.
 * A run whose route the broker refused registers over a connection of its own, keyed by the run.
 */
interface RouteConnection {
	readonly key: string;
	readonly group: string;
	client?: IntercomClient;
	connecting?: Promise<IntercomClient>;
	/** The current client has had a route acknowledged; a client that never has is replaced when one fails. */
	acknowledged: boolean;
	readonly routes: Map<string, RouteState>;
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

function closedError(): Error {
	return new Error("Workflow Intercom route owner closed");
}

export function createWorkflowRouteOwner(cwd: string) {
	const events = createEventBus();
	const config = loadConfig();
	const id = randomUUID();
	const routes = new Map<string, RouteState>();
	const connections = new Map<string, RouteConnection>();

	const isCurrent = (state: RouteState): boolean => routes.get(state.route.runId) === state;
	const connectionKey = (state: RouteState): string => (state.isolated ? state.route.runId : state.route.group);

	function connectionOf(state: RouteState): RouteConnection {
		const key = connectionKey(state);
		let connection = connections.get(key);
		if (connection === undefined) {
			connection = { key, group: state.route.group, acknowledged: false, routes: new Map() };
			connections.set(key, connection);
		}
		connection.routes.set(state.route.runId, state);
		return connection;
	}

	/** Leaves the run's connection; a run's own connection closes with it. */
	function detach(state: RouteState): void {
		const key = connectionKey(state);
		const connection = connections.get(key);
		connection?.routes.delete(state.route.runId);
		if (!state.isolated || connection === undefined) return;
		connections.delete(key);
		void connection.client?.disconnect().catch(() => {});
	}

	function settle(state: RouteState, registered: boolean): void {
		state.registered = registered;
		if (!registered && isCurrent(state)) return;
		for (const waiter of state.waiters) waiter(registered);
		state.waiters.clear();
	}

	function scheduleRetry(state: RouteState): void {
		if (!isCurrent(state) || state.retry !== undefined) return;
		state.retry = setTimeout(
			() => {
				state.retry = undefined;
				void publish(state, state.route).catch(() => {});
			},
			jitteredReconnectDelayMs(state.attempt++),
		);
		state.retry.unref();
	}

	/** The broker dropped every route this client owned; each run registers again over the next one. */
	function drop(connection: RouteConnection, client: IntercomClient): void {
		if (connection.client === client) {
			connection.client = undefined;
			connection.acknowledged = false;
			for (const state of connection.routes.values()) {
				settle(state, false);
				scheduleRetry(state);
			}
		}
		void client.disconnect().catch(() => {});
	}

	function connect(connection: RouteConnection): Promise<IntercomClient> {
		if (connection.client?.isConnected()) return Promise.resolve(connection.client);
		connection.connecting ??= (async () => {
			const [extensionDir] = getBuiltinPackagePaths({
				workflows: false,
				subagents: false,
				mcp: false,
				"web-access": false,
			});
			if (extensionDir === undefined) throw new Error("Intercom builtin package is unavailable");
			await spawnBrokerIfNeeded(config.brokerCommand, config.brokerArgs, config.brokerStartupTimeoutMs, extensionDir);
			if (connections.get(connection.key) !== connection) throw closedError();
			const client = new IntercomClient(`${id}:pending-stage-route:${connection.key}`, {
				multiplexesPendingStageRoutes: true,
			});
			connection.client = client;
			connection.acknowledged = false;
			client.on("error", () => {});
			client.on("disconnected", () => drop(connection, client));
			client.on("pending_stage_message", (request: PendingStageMessageRequest) => {
				if (connection.client !== client) return;
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
				if (connection.client !== client) return;
				events.emit("atomic:workflow-sticky-live-delivered", { ...notice, handled: false });
			});
			try {
				await client.connect({
					cwd,
					model: "workflow",
					pid: process.pid,
					startedAt: Date.now(),
					lastActivity: Date.now(),
					group: connection.group,
					groups: [connection.group],
					recipientPurpose: "control",
				});
				if (connections.get(connection.key) !== connection) throw closedError();
			} catch (error) {
				drop(connection, client);
				throw error;
			}
			// Runs that lost their route with the previous connection register now, not on their own timers.
			for (const state of connection.routes.values()) {
				if (state.registered || state.retry === undefined) continue;
				clearTimeout(state.retry);
				state.retry = undefined;
				void publish(state, state.route).catch(() => {});
			}
			return client;
		})().finally(() => {
			connection.connecting = undefined;
		});
		return connection.connecting;
	}

	function publish(state: RouteState, route: Route): Promise<void> {
		const completion = state.tail
			.catch(() => {})
			.then(async () => {
				if (!isCurrent(state)) throw closedError();
				const connection = connectionOf(state);
				const established =
					connection.acknowledged && connection.client?.isConnected() ? connection.client : undefined;
				let client: IntercomClient | undefined;
				try {
					client = await connect(connection);
					await client.registerPendingStageRouteAcknowledged(
						route.runId,
						route.group,
						route.capability,
						route.stages,
						route.possibleStages,
						route.parent,
					);
					if (connection.client !== client || !isCurrent(state)) return;
					connection.acknowledged = true;
					state.attempt = 0;
					clearTimeout(state.retry);
					state.retry = undefined;
					settle(state, true);
				} catch (error) {
					if (error instanceof IntercomPendingStageRouteRefusedError && error.connectionKept) {
						// #3906: the broker refused only this run and kept the connection with every other run's route,
						// so the run retries on its own backoff over the same connection.
						scheduleRetry(state);
						throw error;
					}
					// An established connection keeps its routes through one failed update; one that never
					// had a route acknowledged, or that is gone, is replaced.
					if (error instanceof IntercomPendingStageRouteRefusedError && !state.isolated && isCurrent(state)) {
						// An older broker ended the group's connection with the refusal; the run retries alone so it
						// cannot end it again.
						detach(state);
						state.isolated = true;
						connectionOf(state);
					}
					if (client !== undefined && (client !== established || !client.isConnected())) drop(connection, client);
					scheduleRetry(state);
					throw error;
				}
			});
		state.tail = completion;
		void completion.catch(() => {});
		return completion;
	}

	events.on("atomic:workflow-pending-stage-route", (payload) => {
		const route = payload as Route;
		let state = routes.get(route.runId);
		if (state === undefined) {
			state = { route, tail: Promise.resolve(), attempt: 0, registered: false, isolated: false, waiters: new Set() };
			routes.set(route.runId, state);
		} else if (state.route.group !== route.group) {
			detach(state);
			state.isolated = false;
			settle(state, false);
		}
		state.route = route;
		connectionOf(state);
		route.completion = publish(state, route);
	});
	events.on("atomic:workflow-pending-stage-undeliverable", (payload) => {
		const event = payload as Undeliverable;
		const state = routes.get(event.runId);
		if (state === undefined || event.handled) return;
		event.handled = true;
		event.completion = (async () => {
			await publish(state, state.route);
			const client = connections.get(connectionKey(state))?.client;
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
		/**
		 * Resolves `true` once the broker holds `runId`'s route over a live connection, waiting out a
		 * reconnect or a retry in progress; `false` for a run this owner does not route or once it closes.
		 */
		registered(runId: string): Promise<boolean> {
			const state = routes.get(runId);
			if (state === undefined) return Promise.resolve(false);
			if (state.registered) return Promise.resolve(true);
			return new Promise((resolve) => state.waiters.add(resolve));
		},
		async closeGroup(group: string): Promise<void> {
			const closing = [...routes.values()].filter((state) => state.route.group === group);
			const closingConnections = [...connections.values()].filter((connection) => connection.group === group);
			for (const connection of closingConnections) {
				connections.delete(connection.key);
				connection.routes.clear();
			}
			for (const state of closing) {
				routes.delete(state.route.runId);
				clearTimeout(state.retry);
				state.retry = undefined;
				settle(state, false);
			}
			await Promise.all(
				closingConnections.map(async (connection) => {
					await connection.client?.disconnect();
					await connection.connecting?.catch(() => {});
				}),
			);
			await Promise.all(closing.map((state) => state.tail.catch(() => {})));
			await Promise.all(closingConnections.map((connection) => connection.client?.disconnect()));
		},
	};
}
