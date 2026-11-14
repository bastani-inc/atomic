/**
 * The command worker host provisioner (#4768), after checking its options: what `workers.provisioner.provisioner`,
 * `startWorkflowFleetController` and `atomic worker controller --provisioner <config.json>` take.
 */

import type { WorkerHostProvisioner } from "../fleet-types.js";
import { createCommandProvisioner } from "./command.js";
import type { CommandProvisionerOptions, WorkerHostProvisionerConfig } from "./types.js";

export { WorkerProvisionerError } from "./cli.js";
export type {
	CommandHostState,
	CommandListFormat,
	CommandProvisionerOptions,
	CommandSteps,
	WorkerHostProvisionerConfig,
	WorkerProvisionerErrorCode,
} from "./types.js";

const HOST_STATES = new Set<string>(["pending", "running", "draining", "stopped", "failed"]);

function invalid(hint: string): TypeError {
	return new TypeError(`Invalid command provisioner options: ${hint}`);
}

type Loose = Readonly<Record<string, string | number | boolean | object | null | undefined>>;

function isCommand(value: Loose[string]): boolean {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every((part: Loose[string]) => typeof part === "string" && part !== "")
	);
}

function checkSteps(field: string, value: Loose[string]): void {
	if (isCommand(value)) return;
	if (Array.isArray(value) && value.length > 0 && value.every((command: Loose[string]) => isCommand(command))) return;
	throw invalid(
		`${field} must be a non-empty array of strings: an executable and its arguments, or a non-empty array of such commands, run in order.`,
	);
}

function checkListFormat(format: Loose[string]): void {
	if (format === undefined) return;
	if (typeof format !== "object" || format === null || Array.isArray(format))
		throw invalid("listFormat must be an object.");
	const fields = format as Loose;
	for (const field of ["items", "id", "state", "since", "hostId"])
		if (fields[field] !== undefined && (typeof fields[field] !== "string" || fields[field] === ""))
			throw invalid(`listFormat.${field} must be a non-empty path when given.`);
	const states = fields.states;
	if (states === undefined) return;
	if (
		typeof states !== "object" ||
		states === null ||
		Array.isArray(states) ||
		!Object.values(states as Loose).every((state) => state === null || HOST_STATES.has(state as string))
	)
		throw invalid(
			"listFormat.states must map each provider state to pending, running, draining, stopped, failed or null.",
		);
}

/** The command provisioner of `config`, after checking it; it throws a `TypeError` naming the option at fault. */
export function createWorkerHostProvisioner(config: WorkerHostProvisionerConfig): WorkerHostProvisioner {
	const fields = config as unknown as Loose;
	if (fields.kind !== "command")
		throw new TypeError(`Invalid provisioner options: kind must be "command", not ${JSON.stringify(fields.kind)}.`);
	checkSteps("up", fields.up);
	checkSteps("down", fields.down);
	checkSteps("list", fields.list);
	if (fields.upEach !== undefined && typeof fields.upEach !== "boolean")
		throw invalid("upEach must be true or false when given.");
	checkListFormat(fields.listFormat);
	const timeoutMs = fields.timeoutMs;
	if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1))
		throw invalid("timeoutMs must be a positive integer.");
	return createCommandProvisioner(config as CommandProvisionerOptions);
}
