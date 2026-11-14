/**
 * The `kubernetes` worker host provisioner (#4768): a Deployment or StatefulSet of `atomic worker start` pods driven
 * through `kubectl scale`, `get` and `delete`. Credentials are kubectl's own: its kubeconfig, or the pod's service
 * account when the controller runs in the cluster.
 */

import type { ProvisionedHost, WorkerHostProvisioner } from "../fleet-types.js";
import { type CliCall, parseJson, runCli, WorkerProvisionerError } from "./cli.js";
import type { KubernetesProvisionerOptions } from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
/** What kubectl prints when its credentials are missing, expired or refused, or lack the Role. */
const AUTH_FAILURE = /Unauthorized|Forbidden|must be logged in|provide credentials|token has expired|refresh token/i;

/** A pod phase as a host state. A pod whose node stopped reporting (`Unknown`) may come back: it stays pending. */
const STATES: Readonly<Record<string, ProvisionedHost["state"]>> = {
	Pending: "pending",
	Running: "running",
	Succeeded: "stopped",
	Failed: "failed",
	Unknown: "pending",
};

interface Pod {
	readonly metadata: {
		readonly name: string;
		readonly creationTimestamp?: string;
		readonly deletionTimestamp?: string;
	};
	readonly status?: { readonly phase?: string; readonly startTime?: string };
}

function isPod(value: unknown): value is Pod {
	const pod = value as Partial<Pod> | null;
	return typeof pod === "object" && pod !== null && typeof pod.metadata?.name === "string" && pod.metadata.name !== "";
}

function time(text: string | undefined): number | undefined {
	const parsed = text === undefined ? Number.NaN : Date.parse(text);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export function createKubernetesProvisioner(options: KubernetesProvisionerOptions): WorkerHostProvisioner {
	const [resource, name] =
		options.deployment === undefined ? ["statefulset", options.statefulSet!] : ["deployment", options.deployment];
	const workload = `${resource}/${name}`;
	const scope = [
		"--namespace",
		options.namespace,
		...(options.context === undefined ? [] : ["--context", options.context]),
	];
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const kubectl = (label: string, args: readonly string[], signal: AbortSignal) => {
		const call: CliCall = {
			label: `kubectl ${label}`,
			file: "kubectl",
			args: [...scope, ...args],
			timeoutMs,
			authFailure: AUTH_FAILURE,
		};
		return runCli(call, signal);
	};
	/** The workload's pods, or the one named `only`. */
	const pods = async (signal: AbortSignal, only?: string): Promise<Pod[]> => {
		const list = parseJson(
			"kubectl get pods",
			await kubectl(
				"get pods",
				[
					"get",
					"pods",
					"--selector",
					options.selector,
					...(only === undefined ? [] : ["--field-selector", `metadata.name=${only}`]),
					"--output",
					"json",
				],
				signal,
			),
		) as { readonly items?: unknown } | null;
		const items = list?.items;
		if (!Array.isArray(items) || !items.every(isPod))
			throw new WorkerProvisionerError("malformed", "kubectl get pods printed JSON that is not a list of pods.");
		return items;
	};
	const replicas = async (signal: AbortSignal): Promise<number> => {
		const read = parseJson(
			`kubectl get ${resource}`,
			await kubectl(`get ${resource}`, ["get", resource, name, "--output", "json"], signal),
		) as { readonly spec?: { readonly replicas?: unknown } } | null;
		const count = read?.spec?.replicas;
		if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
			throw new WorkerProvisionerError("malformed", `kubectl get ${resource} printed no replica count.`);
		return count;
	};
	const scale = (args: readonly string[], signal: AbortSignal) =>
		kubectl("scale", ["scale", workload, ...args], signal);
	return {
		kind: "kubernetes",
		async list(signal) {
			const hosts: ProvisionedHost[] = [];
			for (const pod of await pods(signal)) {
				// A terminating pod already left the workload's replicas.
				if (pod.metadata.deletionTimestamp !== undefined) continue;
				const state = STATES[pod.status?.phase ?? "Pending"] ?? "pending";
				const since =
					(state === "running" ? time(pod.status?.startTime) : undefined) ??
					time(pod.metadata.creationTimestamp) ??
					Date.now();
				hosts.push({ id: pod.metadata.name, state, since });
			}
			return hosts;
		},
		async scaleTo(target, signal) {
			await scale([`--replicas=${target}`], signal);
		},
		async drain(id, signal) {
			const [pod] = await pods(signal, id);
			// Unknown, not the workload's, or already terminating: nothing to remove.
			if (pod === undefined || pod.metadata.deletionTimestamp !== undefined) return;
			const phase = pod.status?.phase;
			const deletePod = () =>
				kubectl("delete pod", ["delete", "pod", id, "--wait=false", "--ignore-not-found"], signal);
			if (phase === "Succeeded" || phase === "Failed") {
				// An ended pod no longer counts among the replicas, which replaced it already.
				await deletePod();
				return;
			}
			const count = await replicas(signal);
			if (count === 0) return;
			if (resource === "statefulset") {
				// A StatefulSet removes its highest ordinal when it scales down, and recreates any other pod deleted.
				if (id !== `${name}-${count - 1}`) return;
			} else {
				// The ReplicaSet replaces the deleted pod with a pending one, which the scale-down then removes first.
				await deletePod();
			}
			// Precondition on the count read: a scale-down that raced another change fails rather than removing twice.
			await scale([`--replicas=${count - 1}`, `--current-replicas=${count}`], signal);
		},
	};
}
