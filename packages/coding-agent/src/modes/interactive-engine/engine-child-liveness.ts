import { setCallbackActivityReporter } from "../../core/callback-activity.ts";
import {
	INTERACTIVE_ENGINE_PROTOCOL_VERSION,
	serializeInteractiveEngineMessage,
} from "./protocol.ts";

export interface InteractiveEngineLiveness {
	ready(): void;
	bound(): void;
	stop(): void;
}

let activeLiveness: InteractiveEngineLiveness | undefined;

export function startInteractiveEngineLiveness(write: (line: string) => void): InteractiveEngineLiveness {
	if (activeLiveness) return activeLiveness;
	if (process.env.ATOMIC_INTERACTIVE_ENGINE_CHILD !== "1") return { ready: () => {}, bound: () => {}, stop: () => {} };
	const send = (message: Parameters<typeof serializeInteractiveEngineMessage>[0]) => {
		write(serializeInteractiveEngineMessage(message));
	};
	setCallbackActivityReporter({
		started: (activity) => send({ type: "engine_activity_started", activity }),
		finished: (activityId) => send({ type: "engine_activity_finished", activityId }),
	});
	const heartbeat = setInterval(() => send({ type: "engine_heartbeat", at: performance.now() }), 50);
	heartbeat.unref?.();
	let readySent = false;
	let boundSent = false;
	const liveness: InteractiveEngineLiveness = {
		ready: () => {
			if (readySent) return;
			readySent = true;
			send({ type: "engine_ready", protocolVersion: INTERACTIVE_ENGINE_PROTOCOL_VERSION, pid: process.pid });
		},
		bound: () => {
			if (boundSent) return;
			boundSent = true;
			send({ type: "engine_bound" });
		},
		stop: () => {
			clearInterval(heartbeat);
			setCallbackActivityReporter(undefined);
			if (activeLiveness === liveness) activeLiveness = undefined;
		},
	};
	activeLiveness = liveness;
	return liveness;
}
