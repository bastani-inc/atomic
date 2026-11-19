import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PROVIDER = "viewlat";
export const MODEL = "viewlat-model";
export const SUBAGENT_NAME = "vl-streamer";

export interface BenchDirectories {
	readonly root: string;
	readonly agentDir: string;
	readonly project: string;
	readonly readPath: string;
}

export function createDirectories(root: string): BenchDirectories {
	const agentDir = join(root, "home", ".atomic", "agent");
	const project = join(root, "project");
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	mkdirSync(project, { recursive: true });
	const readPath = join(project, "NOTES.md");
	writeFileSync(readPath, "# Notes\n\nA short file every streaming agent reads between its turns.\n");
	return { root, agentDir, project, readPath };
}

export function writeAgentConfiguration(dirs: BenchDirectories, port: number): void {
	writeFileSync(
		join(dirs.agentDir, "models.json"),
		`${JSON.stringify(
			{
				providers: {
					[PROVIDER]: {
						baseUrl: `http://127.0.0.1:${port}/v1`,
						api: "openai-completions",
						apiKey: "viewlat",
						models: [
							{
								id: MODEL,
								name: MODEL,
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 20_000_000,
								maxTokens: 4096,
							},
						],
					},
				},
			},
			null,
			2,
		)}\n`,
	);
	writeFileSync(
		join(dirs.agentDir, "settings.json"),
		`${JSON.stringify(
			{
				defaultProvider: PROVIDER,
				defaultModel: MODEL,
				lastChangelogVersion: "999.0.0",
				firstRunOnboardingStartedVersion: "0.0.0",
				onboardedVersion: "0.0.0",
				quietStartup: true,
				collapseChangelog: true,
				sessionSummary: { enabled: false },
				compaction: { enabled: false },
				enableInstallTelemetry: false,
				cacheWarming: "off",
			},
			null,
			2,
		)}\n`,
	);
	writeFileSync(
		join(dirs.agentDir, "agents", `${SUBAGENT_NAME}.md`),
		[
			"---",
			`name: ${SUBAGENT_NAME}`,
			"description: Streams without end for the view-latency benchmark.",
			"systemPromptMode: replace",
			"inheritProjectContext: false",
			"inheritSkills: false",
			"tools: read",
			`model: ${PROVIDER}/${MODEL}`,
			"defaultContext: fork",
			"---",
			"",
			"Stream your work.",
			"",
		].join("\n"),
	);
}

/** Seeds the long transcript through the built package and returns its session id. */
export function seedSession(dirs: BenchDirectories, distIndex: string, entries: number, scriptPath: string): string {
	const result = spawnSync("node", [scriptPath, distIndex, dirs.project, String(entries)], {
		cwd: dirs.project,
		env: { ...process.env, ATOMIC_CODING_AGENT_DIR: dirs.agentDir },
		encoding: "utf8",
		timeout: 300_000,
	});
	if (result.status !== 0) throw new Error(`seeding the session failed: ${result.stderr || result.stdout}`);
	const id = result.stdout.trim().split(/\s+/).at(-1);
	if (!id) throw new Error("seeding the session printed no id");
	return id;
}

export function benchEnvironment(dirs: BenchDirectories, extra: Record<string, string>): Record<string, string> {
	const environment: Record<string, string> = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (value === undefined || name.startsWith("ATOMIC_") || name === "CI") continue;
		environment[name] = value;
	}
	return {
		...environment,
		ATOMIC_CODING_AGENT_DIR: dirs.agentDir,
		ATOMIC_OFFLINE: "1",
		ATOMIC_SKIP_VERSION_CHECK: "1",
		ATOMIC_TELEMETRY: "0",
		TERM: "xterm-256color",
		COLORTERM: "truecolor",
		// Windows' PTY adds this environment to the driver's own, so a CI value inherited there must be overridden:
		// in CI Atomic falls back to the main-screen renderer.
		CI: "0",
		...extra,
	};
}
