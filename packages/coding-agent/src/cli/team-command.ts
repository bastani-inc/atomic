/**
 * `atomic team join|status|leave`: the recommended team layout as one command, over the SDK's `joinTeam`,
 * `getTeamProfile` and `leaveTeam`. Workflow runs and Intercom routing share a team database; sessions stay local.
 */

import { APP_NAME } from "../config.js";
import type { IntercomBrokerControl } from "../core/intercom-broker-control.js";
import { StorageError } from "../core/storage/errors.js";
import { processStorageEnvironment } from "../core/storage/process-selection.js";
import { collectStorageStatus, describeStorageError, type StorageStatus } from "../core/storage/storage-status.js";
import {
	getTeamProfile,
	joinTeamWith,
	leaveTeamWith,
	type TeamBrokerRestart,
	type TeamProfile,
	type TeamProfileName,
} from "../core/storage/team.js";
import { isTeamProfileConfigError, isTeamProfileError, TeamProfileConfigError } from "../core/storage/team-errors.js";
import { LIBSQL_ADAPTER_PACKAGE } from "../core/storage/team-profile.js";
import { createGitEnvironment } from "../utils/git-env.ts";
import { failed, formatStorageStatus, loadBrokerControl } from "./storage-command.js";

const HELP = `Usage:
  ${APP_NAME} team join <url> [--token-file <path>] [--prefix <prefix>]
  ${APP_NAME} team status [--json]
  ${APP_NAME} team leave

Commands:
  join     Share workflow runs and Intercom with your team through a libSQL / Turso database while
           sessions stay on this machine. Checks the token and the connection with
           ${LIBSQL_ADAPTER_PACKAGE}, stores the token in the agent directory (mode 600), sets the
           global \`storage\` setting to the team database and \`sessions.storage\` to the local store in
           one write, restarts the Intercom broker, and prints the storage status. While multi-node
           routing is on, sessions join a project group (project:<owner>/<repo>) instead of "default".
           Nothing is changed when a check fails.
  status   Show the profile in effect (individual, team, ci or custom) and the storage status. Exits 1
           when a selection is invalid, an adapter cannot load, or a database does not answer.
  leave    Restore the individual layout: remove \`storage\` and \`sessions.storage\` when they hold what
           \`team join\` wrote, delete that token file unless a setting still references it, and restart
           the Intercom broker. Other settings are unchanged; running it again changes nothing.

Options:
  --json                Print the status as JSON
  --token-file <path>   File holding the database token, for example from \`turso db tokens create\`;
                        surrounding whitespace is removed. Required except for file: URLs
  --prefix <prefix>     Table prefix, to share one database between teams`;

const HELP_HINT = `Use "${APP_NAME} team --help" for usage.`;

export type TeamCommand =
	| { readonly kind: "help" }
	| { readonly kind: "join"; readonly url: string; readonly tokenFile?: string; readonly prefix?: string }
	| { readonly kind: "status"; readonly json: boolean }
	| { readonly kind: "leave" };

const PROFILE_DESCRIPTIONS: Readonly<Record<TeamProfileName, string>> = {
	individual: "sessions and workflow runs on this machine; Intercom on this machine only",
	team: "sessions on this machine; workflow runs and Intercom on the team database",
	ci: "sessions, workflow runs and Intercom on the team database",
	custom: "matches no preset; see the selections below",
};

function usage(
	code: "unknown-command" | "unknown-option" | "missing-value" | "unexpected-argument" | "missing-url",
	field: string,
	hint: string,
): TeamProfileConfigError {
	return new TeamProfileConfigError(code, { source: "cli", field, hint });
}

/** Parse the arguments after `team`. An option is named without any `=value` part, which could hold a secret. */
export function parseTeamCommand(args: readonly string[]): TeamCommand {
	const [command, ...rest] = args;
	if (command === undefined || command === "help" || args.includes("--help") || args.includes("-h")) {
		return { kind: "help" };
	}
	if (command !== "join" && command !== "status" && command !== "leave") {
		throw usage("unknown-command", "<command>", `Use join, status or leave. ${HELP_HINT}`);
	}
	const positional: string[] = [];
	const values = new Map<string, string>();
	let json = false;
	for (let index = 0; index < rest.length; index++) {
		const arg = rest[index]!;
		if (command === "status" && arg === "--json") {
			json = true;
			continue;
		}
		if (command === "join" && (arg === "--token-file" || arg === "--prefix")) {
			const value = rest[++index];
			if (value === undefined) throw usage("missing-value", arg, `Pass a value after ${arg}.`);
			values.set(arg, value);
			continue;
		}
		if (arg.startsWith("-")) {
			throw usage(
				"unknown-option",
				arg.split("=")[0]!,
				`"${APP_NAME} team ${command}" does not take it. ${HELP_HINT}`,
			);
		}
		positional.push(arg);
	}
	if (command === "join") {
		if (positional.length === 0) {
			throw usage(
				"missing-url",
				"<url>",
				`Pass the team database URL: ${APP_NAME} team join <url> [--token-file <path>] [--prefix <prefix>]`,
			);
		}
		if (positional.length > 1) {
			throw usage("unexpected-argument", "arguments after <url>", `Pass one URL. ${HELP_HINT}`);
		}
		const tokenFile = values.get("--token-file");
		const prefix = values.get("--prefix");
		return {
			kind: "join",
			url: positional[0]!,
			...(tokenFile === undefined ? {} : { tokenFile }),
			...(prefix === undefined ? {} : { prefix }),
		};
	}
	if (positional.length > 0) {
		throw usage(
			"unexpected-argument",
			`arguments after ${command}`,
			`"${APP_NAME} team ${command}" takes none. ${HELP_HINT}`,
		);
	}
	return command === "status" ? { kind: "status", json } : { kind: "leave" };
}

export interface TeamCommandOptions {
	readonly cwd: string;
	readonly agentDir: string;
	readonly log?: (line: string) => void;
	readonly error?: (line: string) => void;
	/** Defaults to the bundled Intercom package's broker control. */
	readonly loadControl?: () => Promise<IntercomBrokerControl>;
}

function describeRestart(
	restart: TeamBrokerRestart,
	log: (line: string) => void,
	error: (line: string) => void,
): boolean {
	if (restart.status === "failed") {
		error(restart.error.message);
		return false;
	}
	if (restart.status === "not-running") {
		log("No Intercom broker was running; the next session that uses Intercom starts one with these settings.");
	} else if (restart.status === "stopped") {
		log(
			`Stopped the Intercom broker (pid ${restart.previous.pid}); the next session that uses Intercom starts one with these settings.`,
		);
	} else {
		const current = restart.current;
		log(
			`Restarted the Intercom broker: pid ${restart.previous.pid} → ${current.state === "running" ? current.report.pid : (current.pid ?? "unknown")}.`,
		);
	}
	return true;
}

function projectGroupOf(control: IntercomBrokerControl | Error, options: TeamCommandOptions): string | undefined {
	if (control instanceof Error) return undefined;
	return control.projectHomeGroup(options.cwd, options.agentDir, processStorageEnvironment(), createGitEnvironment());
}

async function report(
	options: TeamCommandOptions,
	json: boolean,
	log: (line: string) => void,
): Promise<{ readonly failed: boolean }> {
	let profile: TeamProfile | undefined;
	let profileError: string | undefined;
	try {
		profile = getTeamProfile({ agentDir: options.agentDir, cwd: options.cwd });
	} catch (caught) {
		if (!(caught instanceof StorageError)) throw caught;
		profileError = caught.message;
	}
	const control = await loadBrokerControl(options);
	const collected = await collectStorageStatus({
		cwd: options.cwd,
		agentDir: options.agentDir,
		probe: true,
		...(control instanceof Error ? {} : { control }),
	});
	const status: StorageStatus =
		control instanceof Error
			? { ...collected, broker: { state: "unknown", error: describeStorageError(control) } }
			: collected;
	const projectGroup = projectGroupOf(control, options);
	if (json) {
		log(
			JSON.stringify(
				{
					profile: profile ?? null,
					...(profileError === undefined ? {} : { profileError }),
					...(projectGroup === undefined ? {} : { projectGroup }),
					...status,
				},
				null,
				2,
			),
		);
	} else {
		log(
			profile === undefined
				? `Profile: unknown (${profileError})`
				: `Profile: ${profile.profile} (${PROFILE_DESCRIPTIONS[profile.profile]})`,
		);
		if (projectGroup !== undefined) {
			log(
				`Intercom group: sessions in ${options.cwd} join "${projectGroup}" unless ATOMIC_INTERCOM_GROUP or the Intercom config sets a group; sessions that are already running keep theirs until they restart.`,
			);
		}
		log("");
		for (const line of formatStorageStatus(status)) log(line);
	}
	return { failed: profile === undefined || status.domains.some(failed) };
}

/** Run `atomic team <args>` and return the exit code. */
export async function runTeamCommand(args: readonly string[], options: TeamCommandOptions): Promise<number> {
	const log = options.log ?? ((line: string) => console.log(line));
	const error = options.error ?? ((line: string) => console.error(line));
	try {
		const command = parseTeamCommand(args);
		if (command.kind === "help") {
			log(HELP);
			return 0;
		}
		const context = options.loadControl === undefined ? {} : { loadControl: options.loadControl };
		if (command.kind === "status") return (await report(options, command.json, log)).failed ? 1 : 0;
		if (command.kind === "join") {
			const joined = await joinTeamWith(
				{ ...command, agentDir: options.agentDir, cwd: options.cwd, onProgress: log },
				"cli",
				context,
			);
			log(`Connected to ${command.url}.`);
			if (joined.tokenPath !== undefined) {
				log(
					joined.token === "reused"
						? `Kept the token in ${joined.tokenPath}; it already holds this token.`
						: `Stored the token in ${joined.tokenPath} (mode 600).`,
				);
			}
			log(
				`Set \`storage\` to the team database and \`sessions.storage\` to the local store in ${joined.settingsPath}; other settings are unchanged.`,
			);
			if (joined.replaced !== undefined) log(`It replaces the previous selection: ${joined.replaced}.`);
			const restarted = describeRestart(joined.broker, log, error);
			log("");
			const status = await report(options, false, log);
			return restarted && !status.failed ? 0 : 1;
		}
		const left = await leaveTeamWith({ agentDir: options.agentDir, cwd: options.cwd, onProgress: log }, context);
		if (left.removed.length === 0) {
			log(`Nothing to remove: ${left.settingsPath} holds no settings that \`${APP_NAME} team join\` wrote.`);
		} else {
			log(
				`Removed ${left.removed.map((key) => `\`${key}\``).join(" and ")} from ${left.settingsPath}; other settings are unchanged.`,
			);
		}
		for (const key of left.kept)
			log(`Left \`${key}\` in place: it holds something other than what team join writes.`);
		for (const path of left.deletedTokenFiles) log(`Deleted the token file ${path}.`);
		for (const path of left.keptTokenFiles) log(`Kept the token file ${path}: another setting still references it.`);
		const restarted = left.broker === undefined || describeRestart(left.broker, log, error);
		const profile = getTeamProfile({ agentDir: options.agentDir, cwd: options.cwd });
		log(`Profile: ${profile.profile} (${PROFILE_DESCRIPTIONS[profile.profile]})`);
		return restarted ? 0 : 1;
	} catch (caught) {
		error(
			isTeamProfileError(caught) || isTeamProfileConfigError(caught)
				? caught.message
				: `Error: ${describeStorageError(caught as Error)}`,
		);
		return 1;
	}
}
