import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getEnvValue } from "@bastani/atomic";
import { type AgentLoadDiagnostic, loadAgentsFromDir, loadAgentsFromDirWithDiagnostics } from "./agent-loaders.js";
import { applyBuiltinOverrides, readMergedSubagentSettings } from "./agent-overrides.js";
import {
	BUILTIN_AGENTS_DIR,
	getProjectAgentSettingsPath,
	getProjectAgentSettingsPaths,
	getUserAgentDirs,
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

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDirOld = getUserAgentDirs();
	const userDirNew = path.join(os.homedir(), ".agents");
	const { readDirs: projectAgentDirs, preferredDir: projectAgentsDir } = resolveNearestProjectAgentDirs(cwd);
	const userSettingsLoad = readMergedSubagentSettings(getUserAgentSettingsPaths());
	const projectSettingsLoad = readMergedSubagentSettings(getProjectAgentSettingsPaths(cwd));
	const userSettingsPath = userSettingsLoad.path ?? getUserAgentSettingsPath();
	const projectSettingsPath = projectSettingsLoad.path ?? getProjectAgentSettingsPath(cwd);
	const userSettings = scope === "project" ? EMPTY_SUBAGENT_SETTINGS : userSettingsLoad.settings;
	const projectSettings = scope === "user" ? EMPTY_SUBAGENT_SETTINGS : projectSettingsLoad.settings;

	const builtinAgents = applyBuiltinOverrides(
		loadAgentsFromDir(BUILTIN_AGENTS_DIR, "builtin"),
		userSettings,
		projectSettings,
		userSettingsPath,
		projectSettingsPath,
	);

	const userAgentsOld = scope === "project" ? [] : userDirOld.flatMap((dir) => loadAgentsFromDir(dir, "user"));
	const userAgentsNew = scope === "project" ? [] : loadAgentsFromDir(userDirNew, "user");
	const userAgents = [...userAgentsOld, ...userAgentsNew];

	const projectAgents = scope === "user" ? [] : projectAgentDirs.flatMap((dir) => loadAgentsFromDir(dir, "project"));
	const agents = mergeAgentsForScope(scope, userAgents, projectAgents, builtinAgents).filter(
		(agent) => agent.disabled !== true,
	);

	return { agents, projectAgentsDir };
}

export function discoverAgentsAll(cwd: string): {
	builtin: AgentConfig[];
	user: AgentConfig[];
	project: AgentConfig[];
	userDir: string;
	projectDir: string | null;
	userSettingsPath: string;
	projectSettingsPath: string | null;
	diagnostics: AgentLoadDiagnostic[];
} {
	const userDirOld = getUserAgentDirs();
	const userDirNew = path.join(os.homedir(), ".agents");
	const { readDirs: projectDirs, preferredDir: projectDir } = resolveNearestProjectAgentDirs(cwd);
	const userSettingsLoad = readMergedSubagentSettings(getUserAgentSettingsPaths());
	const projectSettingsLoad = readMergedSubagentSettings(getProjectAgentSettingsPaths(cwd));
	const userSettingsPath = userSettingsLoad.path ?? getUserAgentSettingsPath();
	const projectSettingsPath = projectSettingsLoad.path ?? getProjectAgentSettingsPath(cwd);
	const userSettings = userSettingsLoad.settings;
	const projectSettings = projectSettingsLoad.settings;

	const diagnostics: AgentLoadDiagnostic[] = [];
	const loadDir = (dir: string, source: "builtin" | "user" | "project"): AgentConfig[] => {
		const result = loadAgentsFromDirWithDiagnostics(dir, source);
		diagnostics.push(...result.diagnostics);
		return result.agents;
	};

	const builtin = applyBuiltinOverrides(
		loadDir(BUILTIN_AGENTS_DIR, "builtin"),
		userSettings,
		projectSettings,
		userSettingsPath,
		projectSettingsPath,
	);
	const user = [...userDirOld.flatMap((dir) => loadDir(dir, "user")), ...loadDir(userDirNew, "user")];
	const projectMap = new Map<string, AgentConfig>();
	for (const dir of projectDirs) {
		for (const agent of loadDir(dir, "project")) {
			projectMap.set(agent.name, agent);
		}
	}
	const project = Array.from(projectMap.values());

	const legacyUserAgentDir = userDirOld[0]!;
	// ATOMIC_CODING_AGENT_DIR is already applied by getUserAgentDirs(); prefer that resolved path over ~/.agents.
	const userDir = getEnvValue("ATOMIC_CODING_AGENT_DIR")
		? legacyUserAgentDir
		: fs.existsSync(userDirNew)
			? userDirNew
			: legacyUserAgentDir;

	return {
		builtin,
		user,
		project,
		userDir,
		projectDir,
		userSettingsPath,
		projectSettingsPath,
		diagnostics,
	};
}
