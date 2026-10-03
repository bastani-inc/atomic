import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getAgentDir, getAgentDirs, getProjectConfigDirs, type Settings, SettingsManager } from "@bastani/atomic";
import { requestDbosSystemDatabaseUrl } from "../durable/dbos-system-database-url.js";

type DatabaseSettings = NonNullable<Exclude<Settings["workflows"], string[]>>["durability"];

const DATABASE_SETTING_KEYS: ReadonlySet<string> = new Set(["systemDatabaseUrl", "systemDatabaseUrlFile"]);

export interface WorkflowDatabaseSettingsDirectories {
	readonly global: string;
	readonly project: string;
}

function databaseSettings(settings: Settings): DatabaseSettings {
	const workflows: Settings["workflows"] | null = settings.workflows;
	if (workflows === undefined || workflows === null || Array.isArray(workflows)) return undefined;
	if (typeof workflows !== "object") throw new TypeError("workflows must be an array of paths or an object");
	return workflows.durability;
}

function readSettingsFile(directory: string): Settings | undefined {
	let parsed: Settings | null;
	try {
		parsed = JSON.parse(readFileSync(join(directory, "settings.json"), "utf8").replace(/^\uFEFF/, ""));
	} catch {
		return undefined;
	}
	return parsed !== null && typeof parsed === "object" ? parsed : undefined;
}

function settingsDirectoryDeclaringDatabase(directories: readonly string[]): string {
	let declaring: string | undefined;
	for (const directory of directories) {
		const settings = readSettingsFile(directory);
		if (settings !== undefined && databaseSettings(settings) !== undefined) declaring ??= directory;
	}
	return declaring ?? directories[0]!;
}

export async function resolveWorkflowDatabaseSettings(
	global: Settings,
	project: Settings,
	directories: WorkflowDatabaseSettingsDirectories,
): Promise<string | undefined> {
	const projectDatabase = databaseSettings(project);
	const database = projectDatabase !== undefined ? projectDatabase : databaseSettings(global);
	if (database === undefined) return undefined;
	if (database === null || typeof database !== "object" || Array.isArray(database)) {
		throw new TypeError("workflows.durability must be an object");
	}
	if (Object.keys(database).some((key) => !DATABASE_SETTING_KEYS.has(key))) {
		throw new TypeError("workflows.durability supports only systemDatabaseUrl or systemDatabaseUrlFile");
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
				: resolve(projectDatabase === undefined ? directories.global : directories.project, file);
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
	const projectDirectories = getProjectConfigDirs(cwd);
	const url = await resolveWorkflowDatabaseSettings(manager.getGlobalSettings(), manager.getProjectSettings(), {
		global: settingsDirectoryDeclaringDatabase(getAgentDirs()),
		project: projectTrusted ? settingsDirectoryDeclaringDatabase(projectDirectories) : projectDirectories[0]!,
	});
	if (url !== undefined) requestDbosSystemDatabaseUrl(url);
}
