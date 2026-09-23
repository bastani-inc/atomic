import type { SupervisedCommandOwner } from "../tools/bash-pty-native.js";
import type { AgentTaskHost } from "./agent-adapter.js";
import type { TaskId, YieldReason } from "./contracts.js";
import type { TaskSupervisor, WaitLease } from "./supervisor.js";

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
}

class ChildCommandTaskRoutes {
	private readonly launchedBy = new Map<TaskId, string>();
	private readonly routes = new Map<string, ChildTaskCompletionRoute>();

	bind(childId: string, route: ChildTaskCompletionRoute): void {
		this.routes.set(childId, route);
	}

	recordLaunch(taskId: TaskId, childId: string): void {
		this.launchedBy.set(taskId, childId);
	}

	launchedByChild(taskId: TaskId, childId: string): boolean {
		return this.launchedBy.get(taskId) === childId;
	}

	openRoute(taskId: TaskId): ChildTaskCompletionRoute | undefined {
		const childId = this.launchedBy.get(taskId);
		const route = childId === undefined ? undefined : this.routes.get(childId);
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

/** Completion route for a task a child launched in this owner, only while that child accepts messages. */
export function childTaskCompletionRoute(host: AgentTaskHost, taskId: TaskId): ChildTaskCompletionRoute | undefined {
	return routesByHost.get(host)?.openRoute(taskId);
}

/** Resolve the parent's live owner per call so session replacement is followed like the parent's own shells. */
export function createChildCommandTaskOwner(resolveHost: () => AgentTaskHost): ChildCommandTaskOwner {
	return {
		bind(childId, route, waits) {
			const host = resolveHost();
			const routes = routesFor(host);
			routes.bind(childId, route);
			const { supervisor, owner } = host.ownerBinding;
			return {
				supervisor,
				owner,
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
