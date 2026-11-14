/**
 * The command worker host provisioner (#4768): three commands of the operator's own, or a preset for a cloud's CLI
 * (`az`, `aws`, `gcloud`, `kubectl`, `gh`), run without a shell. It adds no code per platform: a preset is only
 * configuration, so any platform whose CLI can resize a group, list its members and remove one plugs in the same way.
 */

import type { ProvisionedHost, WorkerHostProvisioner } from "../fleet-types.js";
import { parseJson, runCli, WorkerProvisionerError } from "./cli.js";
import type { CommandListFormat, CommandProvisionerOptions, CommandSteps } from "./types.js";

const DEFAULT_TIMEOUT_MS = 120_000;
/** What the common CLIs print when their credentials are missing, expired or refused. */
const AUTH_FAILURE = new RegExp(
	[
		"unauthori[sz]ed",
		"forbidden",
		"authentication (?:failed|required|error)",
		"not logged in",
		"login required",
		"access ?denied",
		"invalid credential",
		// az
		"az login",
		"AADSTS",
		"AuthorizationFailed",
		// aws
		"Unable to locate credentials",
		"ExpiredToken",
		"InvalidClientTokenId",
		"UnauthorizedOperation",
		// gcloud
		"gcloud auth login",
		"PERMISSION_DENIED",
		"Reauthentication required",
		// gh
		"gh auth login",
		"HTTP 401",
		"Resource not accessible by integration",
	].join("|"),
	"i",
);
const HOST_STATES = new Set<string>(["pending", "running", "draining", "stopped", "failed"]);

type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** The value at the dot-separated `path` of `value`, or `undefined`. */
function at(value: JsonValue | undefined, path: string): JsonValue | undefined {
	let current = value;
	for (const key of path.split(".")) {
		if (typeof current !== "object" || current === null) return undefined;
		current = (current as Readonly<Record<string, JsonValue>>)[key];
	}
	return current;
}

/** The commands of `steps`: one, or several in order. */
function commands(steps: CommandSteps): readonly (readonly string[])[] {
	return Array.isArray(steps[0]) ? (steps as readonly (readonly string[])[]) : [steps as readonly string[]];
}

/** `args` with each `{name}` of `values` replaced. */
function fill(args: readonly string[], values: Readonly<Record<string, string>>): string[] {
	return args.map((arg) => arg.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole));
}

function malformed(format: CommandListFormat | undefined): WorkerProvisionerError {
	return new WorkerProvisionerError(
		"malformed",
		format === undefined
			? "the list command printed JSON that is not an array of hosts with distinct ids, each with a state of pending, running, draining, stopped or failed, and an optional since and hostId."
			: "the list command printed JSON that its listFormat does not match: an array of hosts with distinct ids and states it maps.",
	);
}

export function createCommandProvisioner(options: CommandProvisionerOptions): WorkerHostProvisioner {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const format = options.listFormat;
	/** When each host without a `since` of its own was first listed in its state. */
	let firstListed = new Map<string, { readonly state: string; readonly at: number }>();
	/** Changes run one at a time, so a count read by one is never stale for the next. */
	let changing: Promise<void> = Promise.resolve();
	const serially = <T>(change: () => Promise<T>): Promise<T> => {
		const run = changing.then(change);
		changing = run.then(
			() => {},
			() => {},
		);
		return run;
	};
	const run = (
		name: "up" | "down" | "list",
		args: readonly string[],
		env: Readonly<Record<string, string>>,
		signal: AbortSignal,
	) => {
		const [file, ...rest] = args;
		return runCli(
			{ label: `the ${name} command`, file: file!, args: rest, timeoutMs, env, authFailure: AUTH_FAILURE },
			signal,
		);
	};
	const steps = async (
		name: "up" | "down",
		values: Readonly<Record<string, string>>,
		env: Readonly<Record<string, string>>,
		signal: AbortSignal,
	) => {
		for (const command of commands(options[name])) await run(name, fill(command, values), env, signal);
	};
	const list = async (signal: AbortSignal): Promise<ProvisionedHost[]> => {
		const now = Date.now();
		const seen = new Map<string, { readonly state: string; readonly at: number }>();
		/** Every command's hosts by id: a host that two commands report, as one changed state between them, counts once. */
		const listed = new Map<string, ProvisionedHost>();
		for (const command of commands(options.list)) {
			const output = parseJson("the list command", await run("list", command, {}, signal)) as JsonValue;
			const hosts = read(output, now, seen);
			if (new Set(hosts.map((host) => host.id)).size !== hosts.length) throw malformed(format);
			for (const host of hosts) listed.set(host.id, host);
		}
		firstListed = seen;
		return [...listed.values()];
	};
	/** The hosts of one list command's output. */
	const read = (
		output: JsonValue,
		now: number,
		seen: Map<string, { readonly state: string; readonly at: number }>,
	): ProvisionedHost[] => {
		const items = format?.items === undefined ? output : at(output, format.items);
		if (!Array.isArray(items)) throw malformed(format);
		const hosts: ProvisionedHost[] = [];
		for (const item of items as readonly JsonValue[]) {
			const id = at(item, format?.id ?? "id");
			const value = at(item, format?.state ?? "state");
			const since = at(item, format?.since ?? "since");
			const hostId = at(item, format?.hostId ?? "hostId");
			if (
				(typeof id !== "string" && typeof id !== "number") ||
				id === "" ||
				typeof value !== "string" ||
				(hostId !== undefined && hostId !== null && typeof hostId !== "string")
			)
				throw malformed(format);
			const states = format?.states;
			const state = states === undefined ? value : Object.hasOwn(states, value) ? states[value] : states["*"];
			if (state === null) continue;
			if (state === undefined || !HOST_STATES.has(state)) throw malformed(format);
			const key = String(id);
			let time: number;
			if (typeof since === "number" && Number.isFinite(since)) time = since;
			else if (typeof since === "string" && Number.isFinite(Date.parse(since))) time = Date.parse(since);
			else if (since === undefined || since === null) {
				const first = firstListed.get(key);
				time = first?.state === state ? first.at : now;
				seen.set(key, { state, at: time });
			} else throw malformed(format);
			hosts.push({
				id: key,
				...(typeof hostId === "string" ? { hostId } : {}),
				state: state as ProvisionedHost["state"],
				since: time,
			});
		}
		return hosts;
	};
	return {
		kind: "command",
		list,
		scaleTo(target, signal) {
			return serially(async () => {
				const add = target - (await list(signal)).length;
				if (add <= 0) return;
				for (let index = 0; index < (options.upEach === true ? add : 1); index++) {
					const count = options.upEach === true ? 1 : add;
					const values = { target: String(target), add: String(count) };
					await steps("up", values, { ATOMIC_TARGET: values.target, ATOMIC_ADD: values.add }, signal);
				}
			});
		},
		drain(id, signal) {
			return serially(async () => {
				const hosts = await list(signal);
				const host = hosts.find((entry) => entry.id === id);
				// Unknown, already removed, or already on its way out: nothing to remove.
				if (host === undefined || host.state === "draining") return;
				const values = { id, remaining: String(hosts.length - 1) };
				await steps("down", values, { ATOMIC_PROVIDER_ID: id, ATOMIC_REMAINING: values.remaining }, signal);
			});
		},
	};
}
