/**
 * A process that churns the global settings until it is killed, for the team settings chaos test: `team` joins and
 * leaves the team database in a loop; `unrelated` rewrites an unrelated setting. Each finished step prints one line.
 * A failure that is not a typed team or settings error prints `UNTYPED <name>: <message>` and exits 2.
 */
import type { IntercomBrokerControl } from "../../packages/coding-agent/src/core/intercom-broker-control.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { joinTeamWith, leaveTeamWith } from "../../packages/coding-agent/src/core/storage/team.js";
import { isTeamProfileConfigError, isTeamProfileError } from "../../packages/coding-agent/src/core/storage/team-errors.js";

const [role, agentDir, project, url, tokenFile] = process.argv.slice(2) as [string, string, string, string, string];
const control = { restartIntercomBroker: async () => ({ status: "not-running" }) } as unknown as IntercomBrokerControl;
const context = { loadControl: async () => control };

function untyped(error: unknown): never {
	const failure = error instanceof Error ? error : new Error(String(error));
	process.stdout.write(`UNTYPED ${failure.name}: ${failure.message}\n`);
	process.exit(2);
}

async function step(action: () => Promise<object>): Promise<void> {
	try {
		await action();
		process.stdout.write("ok\n");
	} catch (error) {
		if (!isTeamProfileError(error) && !isTeamProfileConfigError(error)) untyped(error);
		const cause = error.cause instanceof Error ? ` ${error.cause.message.split("\n", 1)[0]}` : "";
		process.stdout.write(`typed ${error.code}${error.code === "settings-unreadable" ? cause : ""}\n`);
	}
}

for (let iteration = 1; ; iteration++) {
	if (role === "team") {
		await step(() => joinTeamWith({ url, tokenFile, agentDir, cwd: project }, "sdk", context));
		await step(() => leaveTeamWith({ agentDir, cwd: project }, context));
	} else {
		const manager = SettingsManager.create(project, agentDir, { projectTrusted: false });
		manager.setLastChangelogVersion(`0.0.${iteration}`);
		await manager.flush();
		const failure = manager.drainErrors()[0];
		const code = (failure?.error as NodeJS.ErrnoException | undefined)?.code;
		if (failure !== undefined && code !== "ELOCKED") untyped(failure.error);
		process.stdout.write(failure === undefined ? "ok\n" : "locked\n");
	}
}
