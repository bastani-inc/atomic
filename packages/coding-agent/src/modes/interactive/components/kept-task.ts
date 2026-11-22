import { getKeybindings } from "@bastani/atomic-tui";
import { clickableKeyTextHint, navActionText, slashCommandHint } from "./nav-keys.ts";

/** Shell tools whose launch can leave its command running in the background. */
const SHELL_TOOLS: ReadonlySet<string> = new Set(["bash", "powershell"]);

/**
 * The task a shell launch left running in the background: a finished `bash` or `powershell` call, not a `wait`, whose
 * result yielded to its task. Undefined for any other call, whose result is not read.
 */
export function keptTaskId(call: {
	readonly toolName: string;
	readonly args: unknown;
	readonly result?: { readonly details?: unknown } | undefined;
	readonly isPartial?: boolean;
}): string | undefined {
	if (!SHELL_TOOLS.has(call.toolName) || call.isPartial === true || call.result === undefined) return undefined;
	const args = call.args;
	if (typeof args === "object" && args !== null && "action" in args && args.action === "wait") return undefined;
	const details = call.result.details;
	if (typeof details !== "object" || details === null || !("observation" in details)) return undefined;
	const observation = details.observation;
	if (typeof observation !== "object" || observation === null) return undefined;
	if (!("kind" in observation) || observation.kind !== "yielded" || !("taskId" in observation)) return undefined;
	return typeof observation.taskId === "string" ? observation.taskId : undefined;
}

/**
 * What a chat offers for a task a call left running: the main chat's `/tasks` lists it (`tasks`); a subagent's chat's
 * own `/tasks`, typed into it, lists it (`ownTasks`); or the waited-shell key opens it, as it does for the newest shell
 * a released subagent waits on (`openWaited`).
 */
export type KeptTaskAction = "tasks" | "ownTasks" | "openWaited";

/**
 * The hint a call's block shows for `action`: `/tasks to manage`, or `<key> opens it` while the key is bound. A click
 * on a command hint runs the main chat's command, so a subagent chat's own `/tasks` runs from a click only through the
 * chat's `route`; without one it is named as text.
 */
export function keptTaskHint(action: KeptTaskAction | undefined, route?: string): string | undefined {
	if (action === "tasks") return slashCommandHint("/tasks to manage");
	if (action === "ownTasks")
		return route === undefined ? "/tasks to manage" : slashCommandHint("/tasks to manage", route);
	if (action !== "openWaited") return undefined;
	const key = navActionText(getKeybindings(), "app.tasks.openWaited");
	return key ? clickableKeyTextHint(key, " opens it") : undefined;
}
