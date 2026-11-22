import { runHintRoute } from "../interactive/components/hint-routes.ts";
import { parseInteractiveEngineCommand } from "./protocol.ts";

/** Runs a clicked hint's command where the route the host handed over leads in this engine; true when the line was one. */
export function handleEngineHintRouteLine(line: string): boolean {
	const command = parseInteractiveEngineCommand(line);
	if (command?.type !== "engine_hint_route") return false;
	runHintRoute(command.componentId, command.command);
	return true;
}
