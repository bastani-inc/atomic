/**
 * The `command` worker host provisioner (#4768): three commands of the operator's own, run without a shell. `up` gets
 * the target count in `ATOMIC_TARGET`, `down` the host's id in `ATOMIC_PROVIDER_ID`, and `list` prints the hosts as a
 * JSON array of `{ id, state, since?, hostId? }`.
 */

import type { ProvisionedHost, WorkerHostProvisioner } from "../fleet-types.js";
import { parseJson, runCli, WorkerProvisionerError } from "./cli.js";
import type { CommandProvisionerOptions } from "./types.js";

const DEFAULT_TIMEOUT_MS = 120_000;
/** What a script's stderr commonly says when its credentials were refused. */
const AUTH_FAILURE =
	/unauthori[sz]ed|forbidden|authentication (?:failed|required|error)|not logged in|login required|access denied|invalid credential/i;
const HOST_STATES = new Set<string>(["pending", "running", "draining", "stopped", "failed"]);

interface ListedHost {
	readonly id: string;
	readonly hostId?: string;
	readonly state: ProvisionedHost["state"];
	readonly since?: number | string;
}

function isListedHost(value: unknown): value is ListedHost {
	const host = value as Partial<ListedHost> | null;
	return (
		typeof host === "object" &&
		host !== null &&
		typeof host.id === "string" &&
		host.id !== "" &&
		(host.hostId === undefined || typeof host.hostId === "string") &&
		HOST_STATES.has(host.state as string) &&
		(host.since === undefined ||
			Number.isFinite(host.since) ||
			(typeof host.since === "string" && Number.isFinite(Date.parse(host.since))))
	);
}

export function createCommandProvisioner(options: CommandProvisionerOptions): WorkerHostProvisioner {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	/** When each host without a `since` of its own was first listed in its state. */
	const firstListed = new Map<string, { readonly state: string; readonly at: number }>();
	const run = (name: "up" | "down" | "list", env: Readonly<Record<string, string>>, signal: AbortSignal) => {
		const [file, ...args] = options[name];
		return runCli(
			{ label: `the ${name} command`, file: file!, args, timeoutMs, env, authFailure: AUTH_FAILURE },
			signal,
		);
	};
	return {
		kind: "command",
		async list(signal) {
			const listed = parseJson("the list command", await run("list", {}, signal));
			if (
				!Array.isArray(listed) ||
				!listed.every(isListedHost) ||
				new Set(listed.map((host) => host.id)).size !== listed.length
			)
				throw new WorkerProvisionerError(
					"malformed",
					"the list command printed JSON that is not an array of hosts with distinct ids, each with a state of pending, running, draining, stopped or failed, and an optional since and hostId.",
				);
			const now = Date.now();
			const seen = new Map<string, { readonly state: string; readonly at: number }>();
			const hosts = listed.map((host): ProvisionedHost => {
				let since: number;
				if (host.since !== undefined) since = typeof host.since === "number" ? host.since : Date.parse(host.since);
				else {
					const first = firstListed.get(host.id);
					since = first?.state === host.state ? first.at : now;
					seen.set(host.id, { state: host.state, at: since });
				}
				return {
					id: host.id,
					...(host.hostId === undefined ? {} : { hostId: host.hostId }),
					state: host.state,
					since,
				};
			});
			firstListed.clear();
			for (const [id, entry] of seen) firstListed.set(id, entry);
			return hosts;
		},
		async scaleTo(target, signal) {
			await run("up", { ATOMIC_TARGET: String(target) }, signal);
		},
		async drain(id, signal) {
			await run("down", { ATOMIC_PROVIDER_ID: id }, signal);
		},
	};
}
