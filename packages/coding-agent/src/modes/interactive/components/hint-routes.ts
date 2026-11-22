import { randomUUID } from "node:crypto";

/**
 * Where a clicked hint's slash command runs when the hint names a route: the chat that drew it, such as a subagent's
 * page whose `/tasks` lists the commands that subagent launched. The main chat's hints name no route and run there.
 *
 * Routes live in the process that drew the hint. The interactive engine's routes start with `e`, so a host that cannot
 * resolve one hands it to its engine; any other route that is not registered leads nowhere.
 */
const routes = new Map<string, (command: string) => boolean>();

let origin: "h" | "e" = "h";

/** Marks this process as the interactive engine: the routes it registers are handed back to it by its host. */
export function markHintRoutesAsEngine(): void {
	origin = "e";
}

/** Registers where a hint's command runs; `run` answers whether it ran it. Dispose to unregister. */
export function registerHintRoute(run: (command: string) => boolean): { readonly route: string; dispose(): void } {
	const route = `${origin}${randomUUID()}`;
	routes.set(route, run);
	return {
		route,
		dispose: () => {
			routes.delete(route);
		},
	};
}

/** Runs `command` where `route` leads in this process; false when the route is not registered here or declined it. */
export function runHintRoute(route: string, command: string): boolean {
	return routes.get(route)?.(command) === true;
}

/** Whether `route` was registered by an interactive engine, which runs it when its host hands it over. */
export function isEngineHintRoute(route: string): boolean {
	return route.startsWith("e");
}
