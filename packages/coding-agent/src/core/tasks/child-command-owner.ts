import type { SupervisedCommandOwner } from "../tools/bash-pty-native.js";
import type { AgentTaskHost } from "./agent-adapter.js";
import type { TaskId, YieldReason } from "./contracts.js";
import { type TaskSupervisor, taskTranscriptSource, type WaitLease } from "./supervisor.js";

export type TaskCompletionMessage = {
	customType: string;
	content: string;
	details: object;
	display: true;
};

/** Live delivery into the child that launched a shell task, while that child still runs. */
export interface ChildTaskCompletionRoute {
	isOpen(): boolean;
	deliver(message: TaskCompletionMessage): Promise<void>;
}

/**
 * Parent-issued capability that lets an in-process subagent child run shell tasks
 * in the parent's task owner, so they appear in the parent's `/tasks` and outlive
 * the child. It never authorizes agent launches.
 */
export interface ChildCommandTaskOwner {
	bind(childId: string, route: ChildTaskCompletionRoute, waits: ChildTaskWaits): SupervisedCommandOwner;
	/** The child's session closed: forget its route, which holds the whole session, so a released child holds nothing. */
	unbind(childId: string): void;
	/**
	 * The child was released while shell tasks it launched still run: their completions reach it through `route` until
	 * the last of them has completed, and the route is then forgotten. Returns false, binding nothing, when none runs.
	 */
	routeReleased(childId: string, route: ChildTaskCompletionRoute): boolean;
}

class ChildCommandTaskRoutes {
	private readonly launchedBy = new Map<TaskId, string>();
	private readonly routes = new Map<string, ChildTaskCompletionRoute>();
	private readonly running = new Map<string, Set<TaskId>>();

	bind(childId: string, route: ChildTaskCompletionRoute): void {
		this.routes.set(childId, route);
	}

	unbind(childId: string): void {
		this.routes.delete(childId);
	}

	/** Routes held now; counted by tests. */
	get routeCount(): number {
		return this.routes.size;
	}

	recordLaunch(taskId: TaskId, childId: string): void {
		this.launchedBy.set(taskId, childId);
		const running = this.running.get(childId);
		if (running === undefined) this.running.set(childId, new Set([taskId]));
		else running.add(taskId);
	}

	routeReleased(childId: string, route: ChildTaskCompletionRoute): boolean {
		if (!this.running.has(childId)) return false;
		const released: ChildTaskCompletionRoute = {
			isOpen: () => true,
			deliver: async (message) => {
				try {
					await route.deliver(message);
				} finally {
					if (!this.running.has(childId) && this.routes.get(childId) === released) this.routes.delete(childId);
				}
			},
		};
		this.routes.set(childId, released);
		return true;
	}

	launchedByChild(taskId: TaskId, childId: string): boolean {
		return this.launchedBy.get(taskId) === childId;
	}

	completionRoute(taskId: TaskId): ChildTaskCompletionRoute | undefined {
		const childId = this.launchedBy.get(taskId);
		if (childId === undefined) return undefined;
		const running = this.running.get(childId);
		running?.delete(taskId);
		if (running?.size === 0) this.running.delete(childId);
		const route = this.routes.get(childId);
		return route?.isOpen() ? route : undefined;
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
 * The task completed: the route to the child that launched it in this owner, only while that child accepts messages.
 * The task no longer counts as running for its child.
 */
export function childTaskCompletionRoute(host: AgentTaskHost, taskId: TaskId): ChildTaskCompletionRoute | undefined {
	return routesByHost.get(host)?.completionRoute(taskId);
}

/** How many children have a completion route in this host's owner. */
export function childCommandRouteCount(host: AgentTaskHost): number {
	return routesByHost.get(host)?.routeCount ?? 0;
}

/**
 * The running task in `host`'s owner whose session is `childId`: the subagent whose shells it launches. A finished
 * subagent has none, since its owner accepts a task's children only while it runs.
 */
function runningSubagentTask(host: AgentTaskHost, childId: string): TaskId | undefined {
	const watched = host.watchOwnerTasks();
	if (!watched.ok) return undefined;
	const tasks = watched.value.snapshot.tasks;
	watched.value.dispose();
	return tasks.find((task) => {
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
export function createChildCommandTaskOwner(resolveHost: () => AgentTaskHost): ChildCommandTaskOwner {
	const boundHosts = new Map<string, AgentTaskHost>();
	const dropRoute = (childId: string): void => {
		const host = boundHosts.get(childId);
		boundHosts.delete(childId);
		if (host !== undefined) routesByHost.get(host)?.unbind(childId);
	};
	return {
		unbind: dropRoute,
		routeReleased: (childId, route) => routesFor(resolveHost()).routeReleased(childId, route),
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
				ownsTask: (taskId) => routes.launchedByChild(taskId, childId),
				onCommandStarted: (taskId) => routes.recordLaunch(taskId, childId),
				waitForTask: (taskId, budgetMs, onRegistered) =>
					supervisor.waitForTaskId(owner, taskId, budgetMs, (wait) => {
						waits.track(supervisor, wait);
						onRegistered?.(wait);
					}),
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
