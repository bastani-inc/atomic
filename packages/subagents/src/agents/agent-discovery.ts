import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getEnvValue } from "@bastani/atomic";
import { mergeAgentsForScope } from "./agent-selection.ts";
import { applyBuiltinOverrides, readMergedSubagentSettings } from "./agent-overrides.ts";
import { loadAgentsFromDir, loadChainsFromDir } from "./agent-loaders.ts";
import {
	BUILTIN_AGENTS_DIR,
	getProjectAgentSettingsPath,
	getProjectAgentSettingsPaths,
	getUserAgentDirs,
	getUserAgentSettingsPath,
	getUserAgentSettingsPaths,
	getUserChainDir,
	getUserChainDirs,
	resolveNearestProjectAgentDirs,
	resolveNearestProjectChainDirs,
} from "./agent-paths.ts";
import {
	EMPTY_SUBAGENT_SETTINGS,
	type AgentConfig,
	type AgentDiscoveryResult,
	type AgentScope,
	type ChainConfig,
	type ChainDiscoveryDiagnostic,
} from "./agent-types.ts";

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
	const agents = mergeAgentsForScope(scope, userAgents, projectAgents, builtinAgents)
		.filter((agent) => agent.disabled !== true);

	return { agents, projectAgentsDir };
}

export function discoverAgentsAll(cwd: string): {
	builtin: AgentConfig[];
	user: AgentConfig[];
	project: AgentConfig[];
	chains: ChainConfig[];
	chainDiagnostics: ChainDiscoveryDiagnostic[];
	userDir: string;
	projectDir: string | null;
	userChainDir: string;
	projectChainDir: string | null;
	userSettingsPath: string;
	projectSettingsPath: string | null;
} {
	const userDirOld = getUserAgentDirs();
	const userDirNew = path.join(os.homedir(), ".agents");
	const userChainDir = getUserChainDir();
	const { readDirs: projectDirs, preferredDir: projectDir } = resolveNearestProjectAgentDirs(cwd);
	const { readDirs: projectChainDirs, preferredDir: projectChainDir } = resolveNearestProjectChainDirs(cwd);
	const userSettingsLoad = readMergedSubagentSettings(getUserAgentSettingsPaths());
	const projectSettingsLoad = readMergedSubagentSettings(getProjectAgentSettingsPaths(cwd));
	const userSettingsPath = userSettingsLoad.path ?? getUserAgentSettingsPath();
	const projectSettingsPath = projectSettingsLoad.path ?? getProjectAgentSettingsPath(cwd);
	const userSettings = userSettingsLoad.settings;
	const projectSettings = projectSettingsLoad.settings;

	const builtin = applyBuiltinOverrides(
		loadAgentsFromDir(BUILTIN_AGENTS_DIR, "builtin"),
		userSettings,
		projectSettings,
		userSettingsPath,
		projectSettingsPath,
	);
	const user = [
		...userDirOld.flatMap((dir) => loadAgentsFromDir(dir, "user")),
		...loadAgentsFromDir(userDirNew, "user"),
	];
	const projectMap = new Map<string, AgentConfig>();
	for (const dir of projectDirs) {
		for (const agent of loadAgentsFromDir(dir, "project")) {
			projectMap.set(agent.name, agent);
		}
	}
	const project = Array.from(projectMap.values());

	const chainMap = new Map<string, ChainConfig>();
	const projectChainDiagnostics: ChainDiscoveryDiagnostic[] = [];
	for (const dir of projectChainDirs) {
		const loaded = loadChainsFromDir(dir, "project");
		projectChainDiagnostics.push(...loaded.diagnostics);
		for (const chain of loaded.chains) {
			chainMap.set(chain.name, chain);
		}
	}
	const userChainLoads = getUserChainDirs().map((dir) => loadChainsFromDir(dir, "user"));
	const chains = [
		...userChainLoads.flatMap((loaded) => loaded.chains),
		...Array.from(chainMap.values()),
	];
	const chainDiagnostics = [
		...userChainLoads.flatMap((loaded) => loaded.diagnostics),
		...projectChainDiagnostics,
	];

	const legacyUserAgentDir = userDirOld[0]!;
	// ATOMIC_CODING_AGENT_DIR is already applied by getUserAgentDirs(); prefer that resolved path over ~/.agents.
	const userDir = getEnvValue("ATOMIC_CODING_AGENT_DIR") ? legacyUserAgentDir : fs.existsSync(userDirNew) ? userDirNew : legacyUserAgentDir;

	return { builtin, user, project, chains, chainDiagnostics, userDir, projectDir, userChainDir, projectChainDir, userSettingsPath, projectSettingsPath };
}
