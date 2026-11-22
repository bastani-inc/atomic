import assert from "node:assert/strict";
import { test } from "vitest";
import {
	isEngineHintRoute,
	markHintRoutesAsEngine,
	registerHintRoute,
} from "../../packages/coding-agent/src/modes/interactive/components/hint-routes.js";
import { handleEngineHintRouteLine } from "../../packages/coding-agent/src/modes/interactive-engine/engine-hint-route.js";
import { serializeInteractiveEngineFrame } from "../../packages/coding-agent/src/modes/interactive-engine/protocol.js";

test("the engine runs a clicked hint's command where the route its host handed back leads, and nothing elsewhere", () => {
	const ran: string[] = [];
	const hostRoute = registerHintRoute(() => true);
	// The routes the engine's chats register are the ones its host hands back.
	markHintRoutesAsEngine();
	const route = registerHintRoute((command) => {
		ran.push(command);
		return true;
	});
	try {
		assert.equal(isEngineHintRoute(hostRoute.route), false);
		assert.equal(isEngineHintRoute(route.route), true);
		const handOver = (componentId: string) =>
			handleEngineHintRouteLine(
				serializeInteractiveEngineFrame({ type: "engine_hint_route", componentId, command: "/tasks" }),
			);
		assert.equal(handOver(route.route), true);
		assert.deepEqual(ran, ["/tasks"]);
		// A route this engine does not hold, as one of a chat it closed, runs nothing.
		route.dispose();
		assert.equal(handOver(route.route), true);
		assert.deepEqual(ran, ["/tasks"]);
		// Its other commands are left to their own handlers.
		assert.equal(
			handleEngineHintRouteLine(
				serializeInteractiveEngineFrame({ type: "engine_custom_dispose", componentId: "c1" }),
			),
			false,
		);
	} finally {
		route.dispose();
		hostRoute.dispose();
	}
});
