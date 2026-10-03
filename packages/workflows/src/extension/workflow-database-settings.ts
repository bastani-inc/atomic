import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getAgentDir, type Settings, SettingsManager } from "@bastani/atomic";
import { requestDbosSystemDatabaseUrl } from "../durable/dbos-system-database-url.js";

type DatabaseSettings = NonNullable<Exclude<Settings["workflows"], string[]>>["durability"];

function databaseSettings(settings: Settings): DatabaseSettings {
	return Array.isArray(settings.workflows) ? undefined : settings.workflows?.durability;
}

export async function resolveWorkflowDatabaseSettings(
	global: Settings,
	project: Settings,
	cwd: string,
	agentDir = getAgentDir(),
): Promise<string | undefined> {
	const projectDatabase = databaseSettings(project);
	const database = projectDatabase ?? databaseSettings(global);
	if (database === undefined) return undefined;
	if (database === null || typeof database !== "object" || Array.isArray(database)) {
		throw new TypeError("workflows.durability must be an object");
	}
	const { systemDatabaseUrl: url, systemDatabaseUrlFile: file } = database;
	if (url !== undefined && file !== undefined) {
		throw new TypeError("Set only one of workflows.durability.systemDatabaseUrl and systemDatabaseUrlFile");
	}
	let value = url;
	if (file !== undefined) {
		if (typeof file !== "string" || file.trim() === "") {
			throw new TypeError("workflows.durability.systemDatabaseUrlFile must be a non-empty path");
		}
		const path =
			file.startsWith("~/") || file.startsWith("~\\")
				? join(homedir(), file.slice(2))
				: resolve(projectDatabase === undefined ? agentDir : join(cwd, ".atomic"), file);
		try {
			value = await readFile(path, "utf8");
		} catch {
			throw new Error("Cannot read workflows.durability.systemDatabaseUrlFile; check its path and permissions");
		}
	}
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim() === "") {
		throw new TypeError("Workflow database selection must contain a non-empty Postgres URL");
	}
	try {
		const parsed = new URL(value.trim());
		if (!["postgres:", "postgresql:"].includes(parsed.protocol) || parsed.hostname === "") throw new Error();
	} catch {
		throw new TypeError("Workflow database selection must contain a valid Postgres URL");
	}
	return value.trim();
}

export async function prepareWorkflowDatabaseSettings(cwd: string, projectTrusted: boolean): Promise<void> {
	if (process.env.DBOS_SYSTEM_DATABASE_URL?.trim()) return;
	const manager = SettingsManager.create(cwd, getAgentDir(), { projectTrusted });
	if (manager.drainErrors().length > 0)
		throw new Error("Cannot read workflow database settings; repair settings.json");
	const url = await resolveWorkflowDatabaseSettings(manager.getGlobalSettings(), manager.getProjectSettings(), cwd);
	if (url !== undefined) requestDbosSystemDatabaseUrl(url);
}
