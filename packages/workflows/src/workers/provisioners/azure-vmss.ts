/**
 * The `azure-vmss` worker host provisioner (#4768): an Azure Virtual Machine Scale Set driven through `az vmss scale`,
 * `list-instances` and `delete-instances`. Credentials are the Azure CLI's own: `az login`, a managed identity, or its
 * `AZURE_*` environment.
 */

import type { ProvisionedHost, WorkerHostProvisioner } from "../fleet-types.js";
import { type CliCall, parseJson, runCli, WorkerProvisionerError } from "./cli.js";
import type { AzureVmssProvisionerOptions } from "./types.js";

const DEFAULT_TIMEOUT_MS = 60_000;
/** What `az` prints when it has no login, or its identity was refused or lacks the role. */
const AUTH_FAILURE =
	/az login|AADSTS\d+|AuthorizationFailed|AuthenticationFailed|InvalidAuthenticationToken|LinkedAuthorizationFailed|\b401\b|\b403\b/i;

/** A scale set instance's provisioning state as a host state; `Deleting` instances are not listed at all. */
const STATES: Readonly<Record<string, ProvisionedHost["state"]>> = {
	creating: "pending",
	succeeded: "running",
	updating: "running",
	migrating: "running",
	failed: "failed",
	canceled: "failed",
};

interface VmssInstance {
	readonly instanceId: string;
	readonly provisioningState: string;
	readonly timeCreated?: string;
}

function isInstance(value: unknown): value is VmssInstance {
	const instance = value as Partial<VmssInstance> | null;
	return (
		typeof instance === "object" &&
		instance !== null &&
		typeof instance.instanceId === "string" &&
		instance.instanceId !== "" &&
		typeof instance.provisioningState === "string" &&
		(instance.timeCreated === undefined || typeof instance.timeCreated === "string")
	);
}

export function createAzureVmssProvisioner(options: AzureVmssProvisionerOptions): WorkerHostProvisioner {
	const scope = [
		"--resource-group",
		options.resourceGroup,
		"--name",
		options.name,
		...(options.subscription === undefined ? [] : ["--subscription", options.subscription]),
	];
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const az = (command: string, args: readonly string[], signal: AbortSignal) => {
		const call: CliCall = {
			label: `az vmss ${command}`,
			file: "az",
			args: ["vmss", command, ...scope, ...args],
			timeoutMs,
			authFailure: AUTH_FAILURE,
		};
		return runCli(call, signal);
	};
	const list = async (signal: AbortSignal): Promise<ProvisionedHost[]> => {
		const instances = parseJson("az vmss list-instances", await az("list-instances", ["--output", "json"], signal));
		if (!Array.isArray(instances) || !instances.every(isInstance))
			throw new WorkerProvisionerError(
				"malformed",
				"az vmss list-instances printed JSON that is not a list of scale set instances.",
			);
		const hosts: ProvisionedHost[] = [];
		for (const instance of instances) {
			const state = instance.provisioningState.toLowerCase();
			// An instance being deleted already left the scale set's capacity.
			if (state === "deleting") continue;
			const created = instance.timeCreated === undefined ? Number.NaN : Date.parse(instance.timeCreated);
			hosts.push({
				id: instance.instanceId,
				state: STATES[state] ?? "pending",
				since: Number.isFinite(created) ? created : Date.now(),
			});
		}
		return hosts;
	};
	return {
		kind: "azure-vmss",
		list,
		async scaleTo(target, signal) {
			await az("scale", ["--new-capacity", String(target), "--no-wait", "--output", "none"], signal);
		},
		async drain(id, signal) {
			// Only an instance the scale set still counts: deleting an unknown or departing one is a no-op.
			if (!(await list(signal)).some((host) => host.id === id)) return;
			await az("delete-instances", ["--instance-ids", id, "--no-wait", "--output", "none"], signal);
		},
	};
}
