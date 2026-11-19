import type { SupervisedCommandOwner } from "../tools/bash-pty-native.js";
import type { AgentTaskHost } from "./agent-adapter.js";
import type { TaskId, YieldReason } from "./contracts.js";
import { type TaskSupervisor, taskTranscriptSource, type WaitLease } from "./supervisor.js";

export type TaskCompletionMessage = {
	customType: string;
	content: string;
	details: { completionId: string; [key: string]: unknown };
	display: true;
};

/** Live delivery into the child that launched a shell task, while that child still runs. */
export interface ChildTaskCompletionRoute {
	isOpen(): boolean;
	deliver(message: TaskCompletionMessage): Promise<void>;
}

/**
 * Parent-issued capability that lets an in-process subagent child run shell tasks in the parent's task owner, so they
 * outlive the child. Each shell names the child's session as the one that launched it: its completion notice goes to
 * that child only, never to the parent or the owner's chat, and only the child's `/tasks` lists it. It never authorizes
 * agent launches.
 */
export interface ChildCommandTaskOwner {
	/** The child's session takes notices through `route` while it runs, including those kept for it meanwhile. */
	bind(childId: string, route: ChildTaskCompletionRoute, waits: ChildTaskWaits): SupervisedCommandOwner;
	/** The child's session closed: forget its route, which holds the whole session, so a released child holds nothing. */
	unbind(childId: string): void;
	/**
	 * The child was released while shell tasks it launched still run, or with notices kept for it: they reach it through
	 * `route`, and the route is forgotten once none runs or waits. Returns false, binding nothing, when there is none.
	 */
	routeReleased(childId: string, route: ChildTaskCompletionRoute): boolean;
	hasOpenHost(): boolean;
}

/** A completion notice kept for a child that could not take it, until it is bound again or released. */
interface KeptNotice {
	readonly message: TaskCompletionMessage;
	readonly taken: () => void;
}

class ChildCommandTaskRoutes {
	private readonly launchedBy = new Map<TaskId, string>();
	private readonly routes = new Map<string, ChildTaskCompletionRoute>();
	private readonly releasedRoutes = new WeakSet<ChildTaskCompletionRoute>();
	private readonly running = new Map<string, Set<TaskId>>();
	private readonly kept = new Map<string, KeptNotice[]>();
	private readonly deliveries = new Map<string, Promise<void>>();
	private readonly flushes = new Map<string, { again: boolean }>();

	bind(childId: string, route: ChildTaskCompletionRoute): void {
		this.routes.set(childId, route);
		this.flushKept(childId);
	}

	unbind(childId: string): void {
		this.routes.delete(childId);
	}

	/** Routes held now; counted by tests. */
	get routeCount(): number {
		return this.routes.size;
	}

	get deliveryCount(): number {
		return this.deliveries.size;
	}

	get launchCount(): number {
		return this.launchedBy.size;
	}

	forgetDelivery(completionId: string, settledTaskId?: TaskId): void {
		this.deliveries.delete(completionId);
		if (settledTaskId === undefined) return;
		const childId = this.launchedBy.get(settledTaskId);
		if (childId === undefined) return;
		this.launchedBy.delete(settledTaskId);
		const running = this.running.get(childId);
		running?.delete(settledTaskId);
		if (running?.size !== 0) return;
		this.running.delete(childId);
		const route = this.routes.get(childId);
		if (route !== undefined && this.releasedRoutes.has(route) && !this.kept.has(childId)) this.routes.delete(childId);
	}

	/** Notices kept for children that could not take them yet; counted by tests. */
	keptCount(childId: string): number {
		return this.kept.get(childId)?.length ?? 0;
	}

	recordLaunch(taskId: TaskId, childId: string): void {
		this.launchedBy.set(taskId, childId);
		const running = this.running.get(childId);
		if (running === undefined) this.running.set(childId, new Set([taskId]));
		else running.add(taskId);
	}

	routeReleased(childId: string, route: ChildTaskCompletionRoute): boolean {
		if (!this.running.has(childId) && !this.kept.has(childId)) return false;
		const released: ChildTaskCompletionRoute = { isOpen: () => true, deliver: (message) => route.deliver(message) };
		this.releasedRoutes.add(released);
		this.routes.set(childId, released);
		this.flushKept(childId);
		return true;
	}

	launchedByChild(taskId: TaskId, childId: string): boolean {
		return this.launchedBy.get(taskId) === childId;
	}

	/**
	 * The task completed: hand its notice to the child that launched it, now if its session takes it, or once it is bound
	 * again or released. Resolves when the child took it; nothing else ever receives it.
	 */
	deliver(childId: string, taskIds: readonly TaskId[], message: TaskCompletionMessage): Promise<void> {
		const existing = this.deliveries.get(message.details.completionId);
		if (existing !== undefined) return existing;
		const delivery = Promise.withResolvers<void>();
		this.deliveries.set(message.details.completionId, delivery.promise);
		const running = this.running.get(childId);
		for (const taskId of taskIds) running?.delete(taskId);
		if (running?.size === 0) this.running.delete(childId);
		const notice = { message, taken: delivery.resolve };
		const kept = this.kept.get(childId);
		if (kept === undefined) this.kept.set(childId, [notice]);
		else kept.push(notice);
		this.flushKept(childId);
		return delivery.promise;
	}

	/** Deliver the notices kept for a child, in order, while its route takes them. */
	private flushKept(childId: string): void {
		const running = this.flushes.get(childId);
		if (running !== undefined) {
			running.again = true;
			return;
		}
		if (!this.kept.has(childId)) return;
		const flush = { again: false };
		this.flushes.set(childId, flush);
		void (async () => {
			try {
				// A bind or release while this flush runs asks for another pass, even after one the route refused.
				do {
					flush.again = false;
					await this.deliverKept(childId);
				} while (flush.again);
			} finally {
				this.flushes.delete(childId);
			}
		})();
	}

	/** Whether every kept notice was delivered; false when the child's route is gone or refused one, which stays kept. */
	private async deliverKept(childId: string): Promise<boolean> {
		for (;;) {
			const kept = this.kept.get(childId);
			const next = kept?.[0];
			if (kept === undefined || next === undefined) return true;
			const route = this.routes.get(childId);
			if (route === undefined || !route.isOpen()) return false;
			try {
				await route.deliver(next.message);
			} catch {
				// The child ended before it took the notice: it stays kept for the child's next run.
				return false;
			}
			kept.shift();
			if (kept.length === 0) this.kept.delete(childId);
			next.taken();
			// A released child keeps its route only while a shell it launched runs or a notice waits for it.
			if (
				this.releasedRoutes.has(route) &&
				!this.running.has(childId) &&
				!this.kept.has(childId) &&
				this.routes.get(childId) === route
			)
				this.routes.delete(childId);
		}
	}
}

const routesByHost = new WeakMap<AgentTaskHost, ChildCommandTaskRoutes>();

function routesFor(host: AgentTaskHost): ChildCommandTaskRoutes {
	let routes = routesByHost.get(host);
	if (!routes) {
		routes = new ChildCommandTaskRoutes();
		routesByHost.set(host, routes);
	}
	return routes;
}

/**
 * Deliver the completion notice of tasks the child session `childId` launched in `host`'s owner to that child only:
 * now while it takes messages, or once it runs again or is released. Resolves when the child took it.
 */
export function deliverToLaunchingSession(
	host: AgentTaskHost,
	childId: string,
	taskIds: TaskId | readonly TaskId[],
	message: TaskCompletionMessage,
): Promise<void> {
	return routesFor(host).deliver(childId, typeof taskIds === "string" ? [taskIds] : taskIds, message);
}

/** How many children have a completion route in this host's owner. */
export function childCommandRouteCount(host: AgentTaskHost): number {
	return routesByHost.get(host)?.routeCount ?? 0;
}

export function childDeliveryCount(host: AgentTaskHost): number {
	return routesByHost.get(host)?.deliveryCount ?? 0;
}

export function childLaunchCount(host: AgentTaskHost): number {
	return routesByHost.get(host)?.launchCount ?? 0;
}

export function forgetChildDelivery(host: AgentTaskHost, completionId: string, settledTaskId?: TaskId): void {
	routesByHost.get(host)?.forgetDelivery(completionId, settledTaskId);
}

/** How many completion notices wait in this host's owner for the child `childId` to take them. */
export function keptChildNoticeCount(host: AgentTaskHost, childId: string): number {
	return routesByHost.get(host)?.keptCount(childId) ?? 0;
}

/**
 * The running task in `host`'s owner whose session is `childId`: the subagent whose shells it launches. A finished
 * subagent has none, since its owner accepts a task's children only while it runs.
 */
function runningSubagentTask(host: AgentTaskHost, childId: string): TaskId | undefined {
	return host.taskRecords().find((task) => {
		if (task.execution.kind !== "running") return false;
		const lease = host.resolveTask(task.ref.taskId);
		const transcript = lease.ok ? taskTranscriptSource(lease.value) : lease;
		return transcript.ok && transcript.value.session.getSessionId() === childId;
	})?.ref.taskId;
}

/**
 * Resolve the parent's live owner per bind so session replacement is followed like the parent's own shells. A child's
 * route is dropped from the owner it was bound to, which stays known while the child is bound: unbinding needs no
 * live parent, so a child closing after its parent closed or was retired still leaves nothing behind.
 */
export function createChildCommandTaskOwner(
	resolveHost: () => AgentTaskHost,
	/** The parent's owner when it already holds one, without opening it. */
	peekHost: () => AgentTaskHost | undefined = () => undefined,
): ChildCommandTaskOwner {
	const boundHosts = new Map<string, AgentTaskHost>();
	const dropRoute = (childId: string): void => {
		const host = boundHosts.get(childId);
		boundHosts.delete(childId);
		if (host !== undefined) routesByHost.get(host)?.unbind(childId);
	};
	return {
		unbind: dropRoute,
		routeReleased: (childId, route) => routesFor(resolveHost()).routeReleased(childId, route),
		hasOpenHost: () => peekHost() !== undefined,
		bind(childId, route, waits) {
			const host = resolveHost();
			if (boundHosts.get(childId) !== host) dropRoute(childId);
			boundHosts.set(childId, host);
			const routes = routesFor(host);
			routes.bind(childId, route);
			const { supervisor, owner } = host.ownerBinding;
			return {
				supervisor,
				owner,
				// The subagent's own `/tasks` lists the shells that name it.
				parentTaskId: runningSubagentTask(host, childId),
				ownsTask: (taskId) =>
					routes.launchedByChild(taskId, childId) ||
					host.taskRecords(new Set([taskId]))[0]?.launchedBy === childId,
				onCommandStarted: (taskId) => routes.recordLaunch(taskId, childId),
				launchOrigin: "subagent-child",
				// The child's session, not the owner's, takes their notices and lists them.
				launchedBy: childId,
				waitForTask: (taskId, budgetMs, onRegistered) =>
					supervisor.waitForTaskId(owner, taskId, budgetMs, (wait) => {
						waits.track(supervisor, wait);
						onRegistered?.(wait);
					}),
				// A subagent's background searches run in its parent's owner, named for the subagent like its shells.
				startToolTask: (intent, operation, runner) => host.startToolTask(intent, operation, runner),
			};
		},
	};
}

/** Child-side waits on parent-owned tasks; inbound child messages release observation, never execution. */
export class ChildTaskWaits {
	private readonly waits = new Map<WaitLease, TaskSupervisor>();

	track(supervisor: TaskSupervisor, wait: WaitLease): void {
		this.waits.set(wait, supervisor);
		const remove = () => this.waits.delete(wait);
		void supervisor.observeTaskWait(wait).then(remove, remove);
	}

	yieldAll(reason: YieldReason): void {
		for (const [wait, supervisor] of this.waits) supervisor.yieldTaskWait(wait, reason);
	}
}
