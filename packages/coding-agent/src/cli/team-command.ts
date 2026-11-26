/**
 * `atomic team status`: the layout in effect over the SDK's `selectTeamProfile`, and the storage status. `team join`
 * and `team leave`, which set up a libSQL team database, were removed with libSQL support.
 */

import { APP_NAME } from "../config.js";
import type { IntercomBrokerControl } from "../core/intercom-broker-control.js";
import {
	isTeamProfileConfigError,
	isTeamProfileError,
	StorageError,
	TeamProfileConfigError,
} from "../core/storage/errors.js";
import { LIBSQL_MIGRATION_DOCS_URL } from "../core/storage/libsql-removed.js";
import { processStorageEnvironment } from "../core/storage/process-selection.js";
import { collectStorageStatus, describeStorageError, type StorageStatus } from "../core/storage/storage-status.js";
import { selectTeamProfile, type TeamProfile, type TeamProfileName } from "../core/storage/team.js";
import { createGitEnvironment } from "../utils/git-env.ts";
import { failed, formatStorageStatus, loadBrokerControl } from "./storage-command.js";

const HELP = `Usage:
  ${APP_NAME} team status [--json]

Commands:
  status   Show the profile in effect (individual, team, ci or custom) and the storage status. Exits 1
           when a selection is invalid, an adapter cannot load, or a database does not answer.

Options:
  --json                Print the status as JSON

To share sessions or Intercom routing through a PostgreSQL database, run ${APP_NAME} storage join postgres://….`;

const HELP_HINT = `Use "${APP_NAME} team --help" for usage.`;

export type TeamCommand = { readonly kind: "help" } | { readonly kind: "status"; readonly json: boolean };

const PROFILE_DESCRIPTIONS: Readonly<Record<TeamProfileName, string>> = {
	individual: "sessions on this machine; Intercom on this machine only",
	team: "sessions on this machine; Intercom on the shared database",
	ci: "sessions and Intercom on the shared database",
	custom: "matches no preset; see the selections below",
};

function usage(
	code: "unknown-command" | "unknown-option" | "unexpected-argument" | "libsql-removed",
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
	if (command === "join" || command === "leave") {
		throw usage(
			"libsql-removed",
			`${APP_NAME} team ${command}`,
			`\`${APP_NAME} team join\` and \`${APP_NAME} team leave\` were removed with libSQL support in Atomic 0.10.11. To share sessions or Intercom routing, join a PostgreSQL database with ${APP_NAME} storage join postgres://…; to leave it, remove the \`storage\` setting. To move sessions off libSQL, see ${LIBSQL_MIGRATION_DOCS_URL}`,
		);
	}
	if (command !== "status") throw usage("unknown-command", "<command>", `Use status. ${HELP_HINT}`);
	let json = false;
	for (const arg of rest) {
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg.startsWith("-")) {
			throw usage("unknown-option", arg.split("=")[0]!, `"${APP_NAME} team status" does not take it. ${HELP_HINT}`);
		}
		throw usage(
			"unexpected-argument",
			"arguments after status",
			`"${APP_NAME} team status" takes none. ${HELP_HINT}`,
		);
	}
	return { kind: "status", json };
}

export interface TeamCommandOptions {
	readonly cwd: string;
	readonly agentDir: string;
	readonly log?: (line: string) => void;
	readonly error?: (line: string) => void;
	/** Defaults to the bundled Intercom package's broker control. */
	readonly loadControl?: () => Promise<IntercomBrokerControl>;
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
		profile = selectTeamProfile({ agentDir: options.agentDir, cwd: options.cwd });
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
		return (await report(options, command.json, log)).failed ? 1 : 0;
	} catch (caught) {
		error(
			isTeamProfileError(caught) || isTeamProfileConfigError(caught)
				? caught.message
				: `Error: ${describeStorageError(caught as Error)}`,
		);
		return 1;
	}
}
