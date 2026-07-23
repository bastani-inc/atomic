import { setCallbackActivityReporter } from "../../core/callback-activity.ts";
import { writeRawStdoutControl } from "../../core/output-guard.ts";
import { startParentProcessGuardian } from "../../utils/shell.ts";
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
	const hostPid = Number.parseInt(process.env.ATOMIC_INTERACTIVE_ENGINE_HOST_PID ?? "", 10);
	const stopGuardian = Number.isSafeInteger(hostPid) && hostPid > 0
		? startParentProcessGuardian(hostPid, process.env.ATOMIC_INTERACTIVE_ENGINE_GUARD_FILE)
		: async () => {};
	const send = (message: Parameters<typeof serializeInteractiveEngineMessage>[0]) => {
		write(serializeInteractiveEngineMessage(message));
	};
	setCallbackActivityReporter({
		started: (activity) => writeRawStdoutControl(serializeInteractiveEngineMessage({ type: "engine_activity_started", activity })),
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
			void stopGuardian();
			if (activeLiveness === liveness) activeLiveness = undefined;
		},
	};
	activeLiveness = liveness;
	return liveness;
}
