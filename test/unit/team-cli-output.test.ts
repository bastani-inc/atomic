import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { runIntercomCommand } from "../../packages/coding-agent/src/cli/intercom-command.js";
import { runStorageCommand } from "../../packages/coding-agent/src/cli/storage-command.js";
import { parseTeamCommand, runTeamCommand } from "../../packages/coding-agent/src/cli/team-command.js";
import type {
	IntercomBrokerControl,
	RestartOutcome,
} from "../../packages/coding-agent/src/core/intercom-broker-control.js";
import {
	LOCAL_SESSIONS_STORAGE,
	POSTGRES_ADAPTER_PACKAGE,
} from "../../packages/coding-agent/src/core/storage/selection.js";
import { ProjectTrustStore } from "../../packages/coding-agent/src/core/trust-manager.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const VARIABLES = [
	"ATOMIC_STORAGE",
	"ATOMIC_SESSIONS_STORAGE",
	"ATOMIC_WORKFLOWS_JOURNAL",
	"ATOMIC_CODING_AGENT_SESSION_DIR",
	"ATOMIC_WORKFLOW_JOURNAL_PATH",
];

let root: string;
let agentDir: string;
let project: string;
let restarts: string[];

beforeEach(() => {
	for (const name of VARIABLES) vi.stubEnv(name, "");
	root = makeTempDirectory("team-transcript-");
	agentDir = join(root, "agent");
	project = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(project, { recursive: true });
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
	restarts = [];
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	removeTempDirectory(root);
});

function underRoot(text: string): string {
	return text.replaceAll(root, "<root>").replace(/<root>\S*/g, (path) => path.replaceAll("\\", "/"));
}

function control(outcome: RestartOutcome | Error, projectGroup?: string): IntercomBrokerControl {
	return {
		BROKER_PROTOCOL: { min: 1, max: 2 },
		upgradeIntercomBroker: async () => ({ status: "not-running" }),
		queryIntercomBroker: async () => ({ state: "stopped" }),
		expectedBrokerStorage: () => undefined,
		readLiveBrokers: async () => [],
		restartIntercomBroker: async (directory, options) => {
			restarts.push(directory);
			options?.onProgress?.("Stopping the Intercom broker (pid 101)");
			if (outcome instanceof Error) throw outcome;
			return outcome;
		},
		describeMultiNodeStatus: () => "on",
		projectHomeGroup: (cwd, directory) => (cwd === project && directory === agentDir ? projectGroup : "wrong"),
	};
}

async function team(
	args: string[],
	broker: IntercomBrokerControl | undefined,
): Promise<{ code: number; out: string; err: string }> {
	const out: string[] = [];
	const err: string[] = [];
	const code = await runTeamCommand(args, {
		cwd: project,
		agentDir,
		log: (line) => out.push(line),
		error: (line) => err.push(line),
		...(broker === undefined ? {} : { loadControl: async () => broker }),
	});
	const normalize = (text: string) =>
		underRoot(text)
			.replace(/storage-token\.[\da-f-]+/g, "storage-token.<id>")
			.replace(/answered in \d+ ms/g, "answered in <n> ms");
	return { code, out: normalize(out.join("\n")), err: normalize(err.join("\n")) };
}

function writeSettings(settings: object): void {
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings, null, 2));
}

describe("atomic team output (#4320)", () => {
	test("parses every command and option exactly (#4320)", () => {
		for (const args of [[], ["help"], ["--help"], ["status", "-h"], ["join", "--help"]]) {
			assert.deepEqual(parseTeamCommand(args), { kind: "help" }, args.join(" "));
		}
		assert.deepEqual(parseTeamCommand(["status"]), { kind: "status", json: false });
		assert.deepEqual(parseTeamCommand(["status", "--json"]), { kind: "status", json: true });
		const rejects = (args: string[], message: string) =>
			assert.throws(
				() => parseTeamCommand(args),
				(error: Error) => error.message === message,
				args.join(" "),
			);
		rejects(
			["doctor"],
			'Invalid team command: <command> (unknown-command). Use status. Use "atomic team --help" for usage.',
		);
		rejects(
			["status", "--prefix", "x"],
			'Invalid team command: --prefix (unknown-option). "atomic team status" does not take it. Use "atomic team --help" for usage.',
		);
		rejects(
			["status", "now"],
			'Invalid team command: arguments after status (unexpected-argument). "atomic team status" takes none. Use "atomic team --help" for usage.',
		);
	});

	test("team join and team leave were removed with libSQL and point to storage join on PostgreSQL", async () => {
		for (const command of ["join", "leave"]) {
			for (const args of [[command], [command, "libsql://db.example.turso.io", "--token-file", "token"]]) {
				const result = await team(args, control({ status: "not-running" }));
				assert.equal(result.code, 1, args.join(" "));
				assert.equal(result.out, "");
				assert.equal(
					result.err,
					`Invalid storage configuration: atomic team ${command} (libsql-removed). \`atomic team join\` and \`atomic team leave\` were removed with libSQL support in Atomic 0.10.11. To share sessions or Intercom routing, join a PostgreSQL database with atomic storage join postgres://…; to leave it, remove the \`storage\` setting. To move sessions off libSQL, see https://docs.bastani.ai/storage#moving-off-libsql`,
				);
			}
		}
		assert.deepEqual(restarts, []);
	});

	test("paths under the temp root are named <root> with forward slashes whatever the platform separator (#4320)", () => {
		assert.equal(
			underRoot(`Set in ${root}\\agent\\settings.json; kept ${root}/sessions and \\unrelated\\text`),
			"Set in <root>/agent/settings.json; kept <root>/sessions and \\unrelated\\text",
		);
	});

	test("help goes to standard output by default (#4320)", async () => {
		const printed = vi.spyOn(console, "log").mockImplementation(() => {});
		assert.equal(await runTeamCommand(["--help"], { cwd: project, agentDir }), 0);
		assert.match(String(printed.mock.calls[0]?.[0]), /^Usage:\n {2}atomic team status \[--json\]\n/);
		assert.doesNotMatch(String(printed.mock.calls[0]?.[0]), /team join|team leave|libSQL/);
		const failed = vi.spyOn(console, "error").mockImplementation(() => {});
		assert.equal(await runTeamCommand(["doctor"], { cwd: project, agentDir }), 1);
		assert.match(String(failed.mock.calls[0]?.[0]), /\(unknown-command\)/);
	});

	test("status reports an invalid selection as an unknown profile and exits 1 (#4320)", async () => {
		vi.stubEnv("ATOMIC_STORAGE", "{not json");
		const text = await team(["status"], control({ status: "not-running" }));
		assert.equal(text.code, 1);
		assert.match(text.out, /^Profile: unknown \(Invalid storage configuration: ATOMIC_STORAGE \(invalid-json\)\)$/m);
		assert.doesNotMatch(text.out, /Intercom group:/);
		const json = await team(["status", "--json"], control({ status: "not-running" }));
		assert.equal(json.code, 1);
		const parsed = JSON.parse(json.out);
		assert.equal(parsed.profile, null);
		assert.equal(parsed.profileError, "Invalid storage configuration: ATOMIC_STORAGE (invalid-json)");
		assert.equal(parsed.projectGroup, undefined);
	});

	test("status without a loadable broker control reports the broker as unknown (#4320)", async () => {
		const out: string[] = [];
		const code = await runTeamCommand(["status", "--json"], {
			cwd: project,
			agentDir,
			log: (line) => out.push(line),
			error: () => {},
			loadControl: () => Promise.reject(new Error("intercom package missing")),
		});
		assert.equal(code, 0);
		const parsed = JSON.parse(out.join("\n"));
		assert.deepEqual(parsed.profile, {
			profile: "individual",
			sessions: `SQLite ${join(agentDir, "workflows", "journal.sqlite")}`,
			intercom: "off",
		});
		assert.deepEqual(parsed.broker, { state: "unknown", error: "intercom package missing" });
		assert.equal(parsed.projectGroup, undefined);
	});

	test("an untyped failure is printed as an error and exits 1 (#4320)", async () => {
		mkdirSync(join(project, ".atomic"), { recursive: true });
		writeFileSync(join(project, ".atomic", "settings.json"), "{ broken");
		new ProjectTrustStore(agentDir).set(project, true);
		const result = await team(["status"], control({ status: "not-running" }));
		assert.equal(result.code, 1);
		assert.match(result.err, /^Error: Cannot load settings: project settings: /);
	});
});

describe("atomic storage join and broker reports (#4320)", () => {
	async function storage(args: string[], broker?: IntercomBrokerControl) {
		const out: string[] = [];
		const err: string[] = [];
		const code = await runStorageCommand(args, {
			cwd: project,
			agentDir,
			log: (line) => out.push(line),
			error: (line) => err.push(line),
			...(broker === undefined ? {} : { loadControl: async () => broker }),
		});
		const normalize = (text: string) => underRoot(text).replace(/storage-token\.[\da-f-]+/g, "storage-token.<id>");
		return { code, out: normalize(out.join("\n")), err: normalize(err.join("\n")) };
	}

	test("storage join prints typed errors as their message alone (#4320)", async () => {
		writeSettings({ theme: "dark" });
		const unsupported = await storage(["join", "mysql://db.example.com/atomic", "--token-file", "t"]);
		assert.equal(unsupported.code, 1);
		assert.equal(
			unsupported.err,
			"Invalid storage configuration: <url> (unsupported-url). Use a postgres:// or postgresql:// URL, for example postgres://atomic@db.example.com:5432/atomic.",
		);
		const passwordFile = join(root, "password");
		writeFileSync(passwordFile, "secret\n");
		const missing = await storage([
			"join",
			"postgres://atomic@db.example.com/atomic",
			"--password-file",
			passwordFile,
		]);
		assert.equal(
			missing.err,
			`The storage adapter is not installed: ${POSTGRES_ADAPTER_PACKAGE} for <root>/agent (adapter-not-installed). Install it, then run this command again: atomic install npm:${POSTGRES_ADAPTER_PACKAGE}`,
		);
	});

	test("a running broker on another selection is reported with how it was started (#4320)", async () => {
		writeSettings({ storage: { memory: true } });
		const running = (source: "env" | "settings"): IntercomBrokerControl => ({
			...control({ status: "not-running" }),
			queryIntercomBroker: async () => ({
				state: "running",
				report: {
					pid: 77,
					sessions: 1,
					storage: { digest: "old", source },
					multiNode: { status: "off" },
				},
			}),
			expectedBrokerStorage: () => ({ digest: "new", source: "settings", adapter: "sqlite" }),
		});
		const fromEnv = await storage(["status"], running("env"));
		assert.match(
			fromEnv.out,
			/^ {2}storage: {5}differs from the selection above \(a session started it with ATOMIC_STORAGE or --storage\); run `atomic intercom restart` to use the current one$/m,
		);
		assert.match(fromEnv.out, /^ {2}multi-node: {2}off: the shared storage selection is in memory$/m);
		const fromSettings = await storage(["status"], running("settings"));
		assert.match(
			fromSettings.out,
			/^ {2}storage: {5}differs from the selection above; run `atomic intercom restart` to use the current one$/m,
		);
		const lines: string[] = [];
		assert.equal(
			await runIntercomCommand(["status"], {
				agentDir,
				log: (line) => lines.push(line),
				loadControl: async () => running("env"),
			}),
			0,
		);
		assert.equal(
			lines[1],
			"Storage: differs from the current selection (a session started it with ATOMIC_STORAGE or --storage); run `atomic intercom restart`",
		);
		lines.length = 0;
		await runIntercomCommand(["status"], {
			agentDir,
			log: (line) => lines.push(line),
			loadControl: async () => running("settings"),
		});
		assert.equal(lines[1], "Storage: differs from the current selection; run `atomic intercom restart`");
		lines.length = 0;
		const unreported: IntercomBrokerControl = {
			...running("env"),
			queryIntercomBroker: async () => ({
				state: "running",
				report: { pid: 78, sessions: 0, multiNode: { status: "off" } },
			}),
		};
		await runIntercomCommand(["status"], {
			agentDir,
			log: (line) => lines.push(line),
			loadControl: async () => unreported,
		});
		assert.equal(lines[1], "Storage: differs from the current selection; run `atomic intercom restart`");
		mkdirSync(join(project, ".atomic"), { recursive: true });
		writeFileSync(join(project, ".atomic", "settings.json"), "{ broken");
		new ProjectTrustStore(agentDir).set(project, true);
		const untyped = await storage(["status"], running("settings"));
		assert.match(untyped.err, /^Error: Cannot load settings: project settings: /);
	});

	test("team status reads the given directories, reports the broker, and fails when any domain fails (#4320)", async () => {
		const elsewhere = join(root, "elsewhere-agent");
		mkdirSync(elsewhere);
		vi.stubEnv("ATOMIC_CODING_AGENT_DIR", elsewhere);
		mkdirSync(join(project, ".atomic"), { recursive: true });
		writeFileSync(join(project, ".atomic", "settings.json"), JSON.stringify({ sessions: { storage: { dir: "s" } } }));
		new ProjectTrustStore(agentDir).set(project, true);
		writeSettings({ sessions: { storage: LOCAL_SESSIONS_STORAGE }, storage: { adapter: "./missing-adapter.ts" } });
		const json = await team(["status", "--json"], control({ status: "not-running" }, "project:x/y"));
		assert.equal(json.code, 1);
		const parsed = JSON.parse(json.out);
		assert.equal(parsed.profile.profile, "custom");
		assert.equal(parsed.projectGroup, "project:x/y");
		assert.deepEqual(parsed.broker, { state: "stopped" });
		const text = await team(["status"], control({ status: "not-running" }, "project:x/y"));
		assert.match(text.out, /^Profile: custom \(matches no preset; see the selections below\)$/m);
		assert.match(text.out, /^Sessions: /m);
		assert.deepEqual(
			parsed.domains.map((domain: { domain: string; probe?: { adapter?: { loaded: boolean } } }) => [
				domain.domain,
				domain.probe?.adapter?.loaded,
			]),
			[
				["sessions", undefined],
				["intercom", false],
			],
		);
		const usage = (() => {
			try {
				parseTeamCommand(["doctor"]);
			} catch (error) {
				return error as { source: string };
			}
			return undefined;
		})();
		assert.equal(usage?.source, "cli");
	});
});
