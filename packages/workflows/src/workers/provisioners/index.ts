/**
 * The built-in worker host provisioners (#4768): `azure-vmss`, `kubernetes` and `command`, each over a CLI the operator
 * already has, so they add no dependency and their credentials stay in that CLI's own chain.
 */

import type { WorkerHostProvisioner } from "../fleet-types.js";
import { createAzureVmssProvisioner } from "./azure-vmss.js";
import { createCommandProvisioner } from "./command.js";
import { createKubernetesProvisioner } from "./kubernetes.js";
import type { WorkerHostProvisionerConfig } from "./types.js";

export { WorkerProvisionerError } from "./cli.js";
export type {
	AzureVmssProvisionerOptions,
	CommandProvisionerOptions,
	KubernetesProvisionerOptions,
	WorkerHostProvisionerConfig,
	WorkerProvisionerErrorCode,
} from "./types.js";

type ConfigFields = Readonly<Record<string, string | number | readonly string[] | undefined>>;

function invalid(kind: string, hint: string): TypeError {
	return new TypeError(`Invalid ${kind} provisioner options: ${hint}`);
}

function checkStrings(kind: string, config: ConfigFields, required: readonly string[], optional: readonly string[]) {
	for (const field of required)
		if (typeof config[field] !== "string" || config[field] === "")
			throw invalid(kind, `${field} must be a non-empty string.`);
	for (const field of optional)
		if (config[field] !== undefined && (typeof config[field] !== "string" || config[field] === ""))
			throw invalid(kind, `${field} must be a non-empty string when given.`);
}

function checkTimeout(kind: string, config: ConfigFields): void {
	const timeoutMs = config.timeoutMs;
	if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1))
		throw invalid(kind, "timeoutMs must be a positive integer.");
}

/**
 * A built-in worker host provisioner, after checking its options: what `workers.provisioner.provisioner`,
 * `startWorkflowFleetController` and `atomic worker controller --provisioner <config.json>` take.
 */
export function createWorkerHostProvisioner(config: WorkerHostProvisionerConfig): WorkerHostProvisioner {
	const fields = config as unknown as ConfigFields;
	switch (config.kind) {
		case "azure-vmss":
			checkStrings(config.kind, fields, ["resourceGroup", "name"], ["subscription"]);
			checkTimeout(config.kind, fields);
			return createAzureVmssProvisioner(config);
		case "kubernetes":
			checkStrings(config.kind, fields, ["namespace", "selector"], ["deployment", "statefulSet", "context"]);
			if ((config.deployment === undefined) === (config.statefulSet === undefined))
				throw invalid(config.kind, "give exactly one of deployment and statefulSet.");
			checkTimeout(config.kind, fields);
			return createKubernetesProvisioner(config);
		case "command":
			for (const field of ["up", "down", "list"] as const) {
				const command = config[field] as readonly unknown[] | undefined;
				if (
					!Array.isArray(command) ||
					command.length === 0 ||
					!command.every((part) => typeof part === "string" && part !== "")
				)
					throw invalid(
						config.kind,
						`${field} must be a non-empty array of strings: an executable and its arguments.`,
					);
			}
			checkTimeout(config.kind, fields);
			return createCommandProvisioner(config);
		default:
			throw new TypeError(
				`Invalid provisioner options: kind must be "azure-vmss", "kubernetes" or "command", not ${JSON.stringify((config as { kind?: unknown }).kind)}.`,
			);
	}
}
