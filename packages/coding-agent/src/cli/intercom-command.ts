/**
 * `atomic intercom restart` replaces the agent directory's Intercom broker, so it reads the current storage
 * selection without closing every session; `atomic intercom status` shows what the running broker uses.
 */

import { APP_NAME } from "../config.js";
import type { BrokerQuery, IntercomBrokerControl } from "../core/intercom-broker-control.ts";

const HELP = `Usage:
  ${APP_NAME} intercom status
  ${APP_NAME} intercom restart

Commands:
  status    Show whether this machine's Intercom broker is running, how many sessions it serves,
            whether it uses the current storage selection, and its multi-node routing state with
            the number of other brokers live in the shared database.
  restart   Stop the broker so it picks up a changed storage selection. Connected sessions
            reconnect and start a new broker within a few seconds; without sessions, the next
            session that uses Intercom starts one.`;

export interface IntercomCommandOptions {
	readonly agentDir: string;
	readonly log?: (line: string) => void;
	readonly error?: (line: string) => void;
	/** Defaults to the bundled Intercom package's broker control. */
	readonly loadControl?: () => Promise<IntercomBrokerControl>;
}

function describeBroker(
	query: Exclude<BrokerQuery, { state: "stopped" }>,
	control: IntercomBrokerControl,
	agentDir: string,
): string[] {
	if (query.state === "legacy") {
		return [
			`Intercom broker: running${query.pid === undefined ? "" : ` (pid ${query.pid})`}, started by an older ${APP_NAME} that does not report its status.`,
		];
	}
	const { report } = query;
	const expected = control.expectedBrokerStorage(agentDir, process.env);
	return [
		`Intercom broker: running (pid ${report.pid}, ${report.sessions} session${report.sessions === 1 ? "" : "s"} connected)`,
		report.storage?.digest === expected?.digest
			? "Storage: matches the current selection"
			: `Storage: differs from the current selection${report.storage?.source === "env" ? " (a session started it with ATOMIC_STORAGE or --storage)" : ""}; run \`${APP_NAME} intercom restart\``,
		`Multi-node routing: ${control.describeMultiNodeStatus(report.multiNode)}`,
	];
}

/** Run `atomic intercom <args>` and return the exit code. */
export async function runIntercomCommand(args: readonly string[], options: IntercomCommandOptions): Promise<number> {
	const log = options.log ?? ((line: string) => console.log(line));
	const error = options.error ?? ((line: string) => console.error(line));
	const [command, ...rest] = args;
	if (command === undefined || command === "help" || args.includes("--help") || args.includes("-h")) {
		log(HELP);
		return 0;
	}
	if ((command !== "restart" && command !== "status") || rest.length > 0) {
		error(
			command === "restart" || command === "status"
				? `Usage: ${APP_NAME} intercom ${command}`
				: `Unknown intercom command "${command}". Use "${APP_NAME} intercom --help" for usage.`,
		);
		return 1;
	}
	try {
		let control: IntercomBrokerControl;
		if (options.loadControl) control = await options.loadControl();
		else {
			const { loadIntercomBrokerControl } = await import("../core/intercom-broker-control.ts");
			control = await loadIntercomBrokerControl();
		}
		const { agentDir } = options;
		if (command === "status") {
			const query = await control.queryIntercomBroker(agentDir);
			if (query.state === "stopped") {
				log("Intercom broker: not running. The next session that uses Intercom starts one.");
				return 0;
			}
			for (const line of describeBroker(query, control, agentDir)) log(line);
			return 0;
		}
		const outcome = await control.restartIntercomBroker(agentDir, { onProgress: log });
		if (outcome.status === "not-running") {
			log(
				"No Intercom broker is running. The next session that uses Intercom starts one with the current storage selection.",
			);
			return 0;
		}
		if (outcome.status === "stopped") {
			log(
				`Stopped the Intercom broker (pid ${outcome.previous.pid}). ${outcome.previous.sessions === 0 ? "No session was connected" : "No session reconnected in time"}, so none started a new one; the next session that uses Intercom starts one with the current storage selection.`,
			);
			return 0;
		}
		const current = outcome.current;
		log(
			`Restarted the Intercom broker: pid ${outcome.previous.pid} → ${current.state === "running" ? current.report.pid : (current.pid ?? "unknown")}.`,
		);
		for (const line of describeBroker(current, control, agentDir)) log(line);
		return 0;
	} catch (caught) {
		error(`Error: ${caught instanceof Error ? caught.message : String(caught)}`);
		return 1;
	}
}
