import * as os from "node:os";
import * as path from "node:path";
import { getEnvValue, type PackageAgentFile } from "@bastani/atomic";
import { pathExists } from "../shared/path-exists.js";
import {
	type AgentLoadDiagnostic,
	loadAgentsFromDir,
	loadAgentsFromDirWithDiagnostics,
	loadPackageAgentsWithDiagnostics,
} from "./agent-loaders.js";
import { applyBuiltinOverrides, readMergedSubagentSettings } from "./agent-overrides.js";
import {
	BUILTIN_AGENTS_DIR,
	getProjectAgentSettingsPath,
	getProjectAgentSettingsPaths,
	getUserAgentDirs,
	getUserAgentReadDirs,
	getUserAgentSettingsPath,
	getUserAgentSettingsPaths,
	resolveNearestProjectAgentDirs,
} from "./agent-paths.js";
import { mergeAgentsForScope } from "./agent-selection.js";
import {
	type AgentConfig,
	type AgentDiscoveryResult,
	type AgentScope,
	EMPTY_SUBAGENT_SETTINGS,
} from "./agent-types.js";

export interface AgentDiscoveryOptions {
	/**
	 * The project trust decision. When false, project agent definitions and the
	 * project settings' agent overrides are not read.
	 */
	readonly projectTrusted: boolean;
	/**
	 * The agent files installed packages ship, in the host's discovery order. Those of project-installed packages are
	 * left out when the project is not trusted.
	 */
	readonly packageAgents?: readonly PackageAgentFile[];
}

/**
 * The discovery options for a host context: its project trust decision, or
 * trusted for a host without one, and the agent files its installed packages ship.
 */
export function contextAgentDiscoveryOptions(ctx: {
	isProjectTrusted?: () => boolean;
	getPackageAgents?: () => readonly PackageAgentFile[];
}): AgentDiscoveryOptions {
	const packageAgents = ctx.getPackageAgents?.() ?? [];
	return {
		projectTrusted: ctx.isProjectTrusted?.() ?? true,
		...(packageAgents.length > 0 ? { packageAgents } : {}),
	};
}

/** Package agent files the discovery may offer: none of a project-installed package in an untrusted project. */
function trustedPackageAgentFiles(options: AgentDiscoveryOptions): readonly PackageAgentFile[] {
	const files = options.packageAgents ?? [];
	return options.projectTrusted ? files : files.filter((file) => file.scope !== "project");
}

/** Whether a package agent belongs to an agent scope: `-e` packages belong to every scope. */
export function packageAgentInScope(agent: Pick<AgentConfig, "packageOrigin">, scope: AgentScope): boolean {
	const installed = agent.packageOrigin?.scope;
	return scope === "both" || installed === "temporary" || installed === scope;
}

/** Every package agent discovery may offer, before user and project agents of the same full name replace any. */
export async function discoverPackageAgents(options: AgentDiscoveryOptions): Promise<AgentConfig[]> {
	return (await loadPackageAgents(options)).agents;
}

async function loadPackageAgents(options: AgentDiscoveryOptions): Promise<{
	agents: AgentConfig[];
	diagnostics: AgentLoadDiagnostic[];
}> {
	const files = trustedPackageAgentFiles(options);
	return files.length > 0 ? loadPackageAgentsWithDiagnostics(files) : { agents: [], diagnostics: [] };
}

/** Nothing of the project is read when it is not trusted. */
async function projectAgentSources(
	cwd: string,
	projectTrusted: boolean,
): Promise<{
	readDirs: string[];
	preferredDir: string | null;
	settingsPaths: string[];
}> {
	const { readDirs, preferredDir } = await resolveNearestProjectAgentDirs(cwd);
	return projectTrusted
		? { readDirs, preferredDir, settingsPaths: await getProjectAgentSettingsPaths(cwd) }
		: { readDirs: [], preferredDir, settingsPaths: [] };
}

async function loadAgentsFromDirs(dirs: readonly string[], source: "user" | "project"): Promise<AgentConfig[]> {
	const agents: AgentConfig[] = [];
	for (const dir of dirs) agents.push(...(await loadAgentsFromDir(dir, source)));
	return agents;
}

export async function discoverAgents(
	cwd: string,
	scope: AgentScope,
	options: AgentDiscoveryOptions,
): Promise<AgentDiscoveryResult> {
	const {
		readDirs: projectAgentDirs,
		preferredDir: projectAgentsDir,
		settingsPaths: projectSettingsPaths,
	} = await projectAgentSources(cwd, options.projectTrusted);
	const userSettingsLoad = await readMergedSubagentSettings(getUserAgentSettingsPaths());
	const projectSettingsLoad = await readMergedSubagentSettings(projectSettingsPaths);
	const userSettingsPath = userSettingsLoad.path ?? getUserAgentSettingsPath();
	const projectSettingsPath = projectSettingsLoad.path ?? (await getProjectAgentSettingsPath(cwd));
	const userSettings = scope === "project" ? EMPTY_SUBAGENT_SETTINGS : userSettingsLoad.settings;
	const projectSettings = scope === "user" ? EMPTY_SUBAGENT_SETTINGS : projectSettingsLoad.settings;

	const builtinAgents = applyBuiltinOverrides(
		await loadAgentsFromDir(BUILTIN_AGENTS_DIR, "builtin"),
		userSettings,
		projectSettings,
		userSettingsPath,
		projectSettingsPath,
	);

	const userAgents = scope === "project" ? [] : await loadAgentsFromDirs(getUserAgentReadDirs(), "user");

	const projectAgents = scope === "user" ? [] : await loadAgentsFromDirs(projectAgentDirs, "project");
	const merged = mergeAgentsForScope(scope, userAgents, projectAgents, builtinAgents);
	const agents = merged.filter((agent) => agent.disabled !== true);
	// Package agents come last and never replace a definition of the same full name: user and project agents win.
	const packageAgents = (await loadPackageAgents(options)).agents.filter((agent) => packageAgentInScope(agent, scope));
	if (packageAgents.length > 0) {
		const names = new Set(merged.map((agent) => agent.name));
		for (const agent of packageAgents) if (!names.has(agent.name)) agents.push(agent);
	}

	return { agents, projectAgentsDir };
}

export async function discoverAgentsAll(
	cwd: string,
	options: AgentDiscoveryOptions,
): Promise<{
	builtin: AgentConfig[];
	user: AgentConfig[];
	project: AgentConfig[];
	/** Agents installed packages ship; shown and run, never modified. */
	package: AgentConfig[];
	userDir: string;
	projectDir: string | null;
	userSettingsPath: string;
	projectSettingsPath: string | null;
	diagnostics: AgentLoadDiagnostic[];
	/** Why package agent files were not offered: a shadowed full name, a dotted name, or no usable namespace. */
	packageDiagnostics: AgentLoadDiagnostic[];
}> {
	const userDirOld = getUserAgentDirs();
	const userDirNew = path.join(os.homedir(), ".agents");
	const {
		readDirs: projectDirs,
		preferredDir: projectDir,
		settingsPaths: projectSettingsPaths,
	} = await projectAgentSources(cwd, options.projectTrusted);
	const userSettingsLoad = await readMergedSubagentSettings(getUserAgentSettingsPaths());
	const projectSettingsLoad = await readMergedSubagentSettings(projectSettingsPaths);
	const userSettingsPath = userSettingsLoad.path ?? getUserAgentSettingsPath();
	const projectSettingsPath = projectSettingsLoad.path ?? (await getProjectAgentSettingsPath(cwd));
	const userSettings = userSettingsLoad.settings;
	const projectSettings = projectSettingsLoad.settings;

	const diagnostics: AgentLoadDiagnostic[] = [];
	const loadDir = async (dir: string, source: "builtin" | "user" | "project"): Promise<AgentConfig[]> => {
		const result = await loadAgentsFromDirWithDiagnostics(dir, source);
		diagnostics.push(...result.diagnostics);
		return result.agents;
	};

	const builtin = applyBuiltinOverrides(
		await loadDir(BUILTIN_AGENTS_DIR, "builtin"),
		userSettings,
		projectSettings,
		userSettingsPath,
		projectSettingsPath,
	);
	const user: AgentConfig[] = [];
	for (const dir of [...userDirOld, userDirNew]) user.push(...(await loadDir(dir, "user")));
	const projectMap = new Map<string, AgentConfig>();
	for (const dir of projectDirs) {
		for (const agent of await loadDir(dir, "project")) {
			projectMap.set(agent.name, agent);
		}
	}
	const project = Array.from(projectMap.values());
	const packageLoad = await loadPackageAgents(options);
	diagnostics.push(...packageLoad.diagnostics);

	const legacyUserAgentDir = userDirOld[0]!;
	// ATOMIC_CODING_AGENT_DIR is already applied by getUserAgentDirs(); prefer that resolved path over ~/.agents.
	const userDir = getEnvValue("ATOMIC_CODING_AGENT_DIR")
		? legacyUserAgentDir
		: (await pathExists(userDirNew))
			? userDirNew
			: legacyUserAgentDir;

	return {
		builtin,
		user,
		project,
		package: packageLoad.agents,
		packageDiagnostics: packageLoad.diagnostics,
		userDir,
		projectDir,
		userSettingsPath,
		projectSettingsPath,
		diagnostics,
	};
}
