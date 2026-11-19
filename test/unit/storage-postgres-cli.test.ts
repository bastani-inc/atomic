import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { parseStorageCommand, runStorageCommand } from "../../packages/coding-agent/src/cli/storage-command.js";
import {
	parseWorkerCommand,
	WorkerCommandError,
	workerJournalSelection,
} from "../../packages/coding-agent/src/cli/worker-command.js";
import { isTeamProfileConfigError } from "../../packages/coding-agent/src/core/storage/errors.js";
import {
	POSTGRES_ADAPTER_PACKAGE,
	STORAGE_TOKEN_FILE,
} from "../../packages/coding-agent/src/core/storage/selection.js";
import { collectStorageStatus } from "../../packages/coding-agent/src/core/storage/storage-status.js";
import { joinSharedDatabase } from "../../packages/coding-agent/src/core/storage/team.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const PASSWORD = "pg-secret-4793-never-print";
const URL_ = "postgres://atomic@db.example.com:5432/atomic?sslmode=verify-full";
const STORAGE_VARIABLES = [
	"ATOMIC_STORAGE",
	"ATOMIC_SESSIONS_STORAGE",
	"ATOMIC_WORKFLOWS_JOURNAL",
	"ATOMIC_CODING_AGENT_SESSION_DIR",
	"ATOMIC_WORKFLOW_JOURNAL_PATH",
	"ATOMIC_PROFILE",
];

let root: string;
let agentDir: string;
let project: string;
let passwordFile: string;

beforeEach(() => {
	for (const name of STORAGE_VARIABLES) vi.stubEnv(name, "");
	root = makeTempDirectory("storage-postgres-cli-");
	agentDir = join(root, "agent");
	project = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(project, { recursive: true });
	passwordFile = join(root, "pg-password");
	writeFileSync(passwordFile, `${PASSWORD}\n`, { mode: 0o600 });
});

afterEach(() => {
	vi.unstubAllEnvs();
	removeTempDirectory(root);
});

function configRefusal(run: () => unknown, code: string, field: string, hint?: RegExp): void {
	assert.throws(run, (error: Error) => {
		assert.ok(isTeamProfileConfigError(error), `${error.name}: ${error.message}`);
		assert.equal(error.code, code);
		assert.equal(error.field, field);
		assert.equal(error.source, "cli");
		if (hint !== undefined) assert.match(error.hint, hint);
		assert.ok(!error.message.includes(PASSWORD), "the refusal never repeats the secret");
		return true;
	});
}

describe("atomic storage join postgres:// arguments (#4793)", () => {
	test("parses a Postgres URL with one credential source (#4793)", () => {
		assert.deepEqual(parseStorageCommand(["join", URL_, "--password-file", "pw", "--prefix", "team_"]), {
			kind: "join",
			url: URL_,
			passwordFile: "pw",
			prefix: "team_",
		});
		assert.deepEqual(parseStorageCommand(["join", "postgresql://atomic@db.internal/atomic", "--token-file", "t"]), {
			kind: "join",
			url: "postgresql://atomic@db.internal/atomic",
			tokenFile: "t",
		});
		for (const [flag, auth] of [
			["azure", "azure-entra"],
			["aws", "aws-iam"],
			["gcp", "gcp-iam"],
		] as const)
			assert.deepEqual(parseStorageCommand(["join", URL_, "--auth", flag]), { kind: "join", url: URL_, auth });
	});

	test("refuses a Postgres URL that carries a password, without repeating it (#4793)", () => {
		for (const url of [
			`postgres://atomic:${PASSWORD}@db.example.com/atomic`,
			`postgresql://db.example.com/atomic?password=${PASSWORD}`,
			`postgres://atomic@db.example.com/atomic?sslmode=require&password=${PASSWORD}`,
		])
			configRefusal(
				() => parseStorageCommand(["join", url, "--password-file", "pw"]),
				"credential-in-url",
				"<url>",
				/carries a password.*--password-file or --token-file/,
			);
	});

	test("refuses missing, conflicting and misplaced credential sources (#4793)", () => {
		configRefusal(
			() => parseStorageCommand(["join", URL_]),
			"missing-token",
			"--password-file",
			/--password-file or --token-file, or a platform credential with --auth/,
		);
		configRefusal(
			() => parseStorageCommand(["join", URL_, "--password-file", "a", "--token-file", "b"]),
			"conflicting-token",
			"--password-file, --token-file, --auth",
		);
		configRefusal(
			() => parseStorageCommand(["join", URL_, "--password-file", "a", "--auth", "azure"]),
			"conflicting-token",
			"--password-file, --token-file, --auth",
		);
		configRefusal(
			() => parseStorageCommand(["join", URL_, "--auth", "kerberos"]),
			"unsupported-auth",
			"--auth",
			/--auth azure, --auth aws or --auth gcp/,
		);
		assert.deepEqual(parseStorageCommand(["join", URL_, "--auth", "aws-iam"]), {
			kind: "join",
			url: URL_,
			auth: "aws-iam",
		});
		configRefusal(
			() => parseStorageCommand(["join", "libsql://db.example.turso.io", "--password-file", "a"]),
			"unsupported-option",
			"--password-file",
			/Only postgres:\/\/ and postgresql:\/\/ URLs take --password-file/,
		);
		configRefusal(
			() => parseStorageCommand(["join", "libsql://db.example.turso.io", "--auth", "azure"]),
			"unsupported-option",
			"--auth",
		);
		for (const url of ["postgres:///atomic", "postgres://[bad/atomic"])
			configRefusal(
				() => parseStorageCommand(["join", url, "--auth", "aws"]),
				"unsupported-url",
				"<url>",
				/postgres:\/\/user@host\[:port\]\/database/,
			);
		configRefusal(
			() => parseStorageCommand(["join", "mysql://db.example.com/atomic", "--token-file", "t"]),
			"unsupported-url",
			"<url>",
			/Use a postgres:\/\/, postgresql:\/\/, libsql:\/\//,
		);
		configRefusal(
			() => parseStorageCommand(["join", "my+postgres://db.example.com/atomic", "--token-file", "t"]),
			"unsupported-url",
			"<url>",
		);
		assert.throws(
			() => parseStorageCommand(["join", URL_, "extra", "--auth", "azure"]),
			/Usage: .*storage join <url>/,
		);
		assert.throws(() => parseStorageCommand(["import", "in", "--limit", "2"]), /Unknown option --limit/);
		assert.throws(() => parseStorageCommand(["join", URL_, "--storage", "{}"]), /Unknown option --storage/);
		assert.throws(() => parseStorageCommand(["join", URL_, "--auth"]), /--auth needs a value/);
	});
});

describe("atomic worker --db postgres:// (#4793)", () => {
	test("passes the password by file reference to a Postgres journal selection (#4793)", () => {
		const command = parseWorkerCommand(["start", "--db", URL_, "--password-file", "pg-password", "--prefix", "p_"], {
			cwd: root,
			cpus: 4,
		});
		assert.equal(command.kind, "start");
		assert.ok(command.kind === "start" && command.database !== undefined);
		assert.deepEqual(workerJournalSelection(command.database), {
			adapter: POSTGRES_ADAPTER_PACKAGE,
			options: { url: URL_ },
			secrets: { password: { file: passwordFile } },
			prefix: "p_",
		});
		const tokenCommand = parseWorkerCommand(["status", "--db", URL_, "--token-file", passwordFile], { cwd: root });
		assert.ok(tokenCommand.kind === "status" && tokenCommand.database !== undefined);
		assert.deepEqual(workerJournalSelection(tokenCommand.database).secrets, { password: { file: passwordFile } });
		const auth = parseWorkerCommand(["start", "--db", URL_, "--auth", "gcp"], { cwd: root });
		assert.ok(auth.kind === "start" && auth.database !== undefined);
		assert.deepEqual(workerJournalSelection(auth.database), {
			adapter: POSTGRES_ADAPTER_PACKAGE,
			options: { url: URL_, auth: "gcp-iam" },
		});
	});

	test("refuses a Postgres --db without one credential source, or with a password in it (#4793)", () => {
		const refused = (args: readonly string[], field: string) =>
			assert.throws(
				() => parseWorkerCommand(args, { cwd: root }),
				(error: unknown) =>
					error instanceof WorkerCommandError && error.field === field && !error.message.includes(PASSWORD),
				args.join(" "),
			);
		refused(["start", "--db", URL_], "--password-file");
		refused(
			["start", "--db", URL_, "--password-file", "a", "--token-file", "b"],
			"--password-file, --token-file, --auth",
		);
		refused(["start", "--db", `postgres://atomic:${PASSWORD}@db/atomic`, "--auth", "aws"], "--db");
		refused(["start", "--db", "libsql://pool.example.turso.io", "--password-file", "a"], "--password-file");
		refused(["start", "--password-file", "a"], "--password-file");
		refused(["start", "--auth", "aws"], "--auth");
	});
});

/** What the fake Postgres adapter saw, per `openDatabase` call. */
interface FakeOpen {
	readonly options: Record<string, string>;
	readonly password?: string;
	readonly query?: string;
}

/**
 * Install a fake `@bastani/atomic-storage-postgres` package for `agentDir`: `openDatabase` records its options and the
 * password it was given (from `context.secret` or `options.password`), refuses `refused` hosts, never answers `hang`
 * hosts, and answers `SELECT 1` and a server-version query.
 */
function installFakePostgres(options?: { readonly loadDelayMs?: number }): { readonly opens: () => FakeOpen[] } {
	const directory = join(root, "fake-postgres");
	const log = join(root, "fake-postgres.log");
	const loadDelay =
		options?.loadDelayMs === undefined
			? ""
			: `await new Promise((resolve) => setTimeout(resolve, ${options.loadDelayMs}));\n`;
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "package.json"),
		JSON.stringify({
			name: POSTGRES_ADAPTER_PACKAGE,
			version: "0.0.0",
			type: "module",
			atomic: { storageAdapters: ["./postgres.js"] },
		}),
	);
	writeFileSync(
		join(directory, "postgres.js"),
		`import { appendFileSync } from "node:fs";
${loadDelay}const log = ${JSON.stringify(log)};
export default {
	atomicStorageAdapter: 1,
	liveSecrets: ["password"],
	async openDatabase(options, context) {
		const password = context.secret ? await context.secret("password").catch(() => undefined) : options.password;
		const { password: _omit, ...rest } = options;
		const host = new URL(options.url).hostname;
		const record = (query) => appendFileSync(log, JSON.stringify({ options: rest, password, query }) + "\\n");
		record();
		if (host === "refused") throw new Error("connect ECONNREFUSED 10.0.0.1:5432");
		if (host === "hang") return new Promise(() => {});
		return {
			descriptor: { adapter: "postgres", location: host },
			async exec(sql) { record(sql); },
			async run() { return { changes: 0 }; },
			async get(sql) {
				record(sql);
				if (/server_version/.test(sql)) return { version: "16.4" };
				// An empty database: no table exists.
				if (/sqlite_master|information_schema/.test(sql)) return undefined;
				return { ok: 1 };
			},
			async all() { return []; },
			async transaction(body) { return body(this); },
			async close() {},
			// A host named wake-<status>[-<reason>] delivers notifications, in that state (#5103).
			...(host.startsWith("wake-")
				? {
						notifications: {
							async state() {
								const [status, ...reason] = host.slice("wake-".length).split("-");
								return reason.length === 0 ? { status } : { status, reason: reason.join("-") };
							},
						},
					}
				: {}),
		};
	},
};
`,
	);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [directory] }, null, 2));
	return {
		opens: () =>
			existsSync(log)
				? readFileSync(log, "utf8")
						.trim()
						.split("\n")
						.map((line) => JSON.parse(line) as FakeOpen)
				: [],
	};
}

function settings(): { storage?: Record<string, unknown>; packages?: string[] } {
	return JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
}

function storageTokenFiles(): string[] {
	return readdirSync(agentDir).filter((name) => name.startsWith(STORAGE_TOKEN_FILE));
}

async function storage(args: string[]): Promise<{ code: number; out: string; err: string }> {
	const out: string[] = [];
	const err: string[] = [];
	const code = await runStorageCommand(args, {
		cwd: project,
		agentDir,
		log: (line) => out.push(line),
		error: (line) => err.push(line),
		loadControl: async () => {
			throw new Error("no broker in this test");
		},
	});
	return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("atomic storage join postgres:// with the adapter (#4793)", () => {
	test("--password-file is copied to a private file and settings hold only its reference (#4793)", async () => {
		const fake = installFakePostgres();
		const result = await storage(["join", URL_, "--password-file", passwordFile, "--prefix", "team_"]);
		assert.equal(result.code, 0, result.err);
		const [tokenName, ...others] = storageTokenFiles();
		assert.ok(tokenName !== undefined && others.length === 0);
		const tokenPath = join(agentDir, tokenName);
		assert.equal(readFileSync(tokenPath, "utf8"), PASSWORD);
		if (process.platform !== "win32") assert.equal(statSync(tokenPath).mode & 0o777, 0o600);
		assert.deepEqual(settings().storage, {
			adapter: POSTGRES_ADAPTER_PACKAGE,
			options: { url: URL_ },
			secrets: { password: { file: `${tokenName}` } },
			prefix: "team_",
		});
		const [open] = fake.opens();
		assert.deepEqual(open?.options, { url: URL_ });
		assert.equal(open?.password, PASSWORD, "the connection check used the password");
		assert.ok(fake.opens().some((entry) => entry.query === "SELECT 1 AS ok"));
		assert.ok(result.out.includes(`Stored the password in ${tokenPath} (mode 600).`), result.out);
		assert.ok(!`${result.out}\n${result.err}`.includes(PASSWORD));
		assert.ok(!readFileSync(join(agentDir, "settings.json"), "utf8").includes(PASSWORD));
	});

	test("--token-file is checked as connections read it, dropping only one final line ending (#4793)", async () => {
		const fake = installFakePostgres();
		writeFileSync(passwordFile, `${PASSWORD}\n\n`);
		const result = await storage(["join", URL_, "--token-file", passwordFile]);
		assert.equal(result.code, 0, result.err);
		assert.equal(fake.opens()[0]?.password, `${PASSWORD}\n`);
	});

	test("--token-file is referenced in place, never copied (#4793)", async () => {
		const fake = installFakePostgres();
		const result = await storage(["join", "postgresql://atomic@db.internal/atomic", "--token-file", passwordFile]);
		assert.equal(result.code, 0, result.err);
		assert.deepEqual(storageTokenFiles(), []);
		assert.deepEqual(settings().storage, {
			adapter: POSTGRES_ADAPTER_PACKAGE,
			options: { url: "postgresql://atomic@db.internal/atomic" },
			secrets: { password: { file: passwordFile } },
		});
		assert.equal(fake.opens()[0]?.password, PASSWORD);
		assert.match(result.out, /read again for every new connection/);
		assert.ok(!result.out.includes(PASSWORD));
	});

	test("--auth writes the platform credential mode and no secret (#4793)", async () => {
		const fake = installFakePostgres();
		const result = await storage(["join", URL_, "--auth", "azure"]);
		assert.equal(result.code, 0, result.err);
		assert.deepEqual(settings().storage, {
			adapter: POSTGRES_ADAPTER_PACKAGE,
			options: { url: URL_, auth: "azure-entra" },
		});
		assert.deepEqual(fake.opens()[0]?.options, { url: URL_, auth: "azure-entra" });
		assert.match(result.out, /The adapter obtains a azure-entra credential for every new connection/);
		assert.deepEqual(storageTokenFiles(), []);
	});

	test("nothing is written when the adapter is missing, the server refuses, or a URL carries a password (#4793)", async () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }));
		const missing = await storage(["join", URL_, "--password-file", passwordFile]);
		assert.equal(missing.code, 1);
		assert.match(missing.err, /atomic install npm:@bastani\/atomic-storage-postgres/);
		assert.deepEqual(settings(), { theme: "dark" });

		installFakePostgres();
		const before = readFileSync(join(agentDir, "settings.json"), "utf8");
		const refused = await storage(["join", "postgres://atomic@refused/atomic", "--password-file", passwordFile]);
		assert.equal(refused.code, 1);
		assert.match(refused.err, /connection-failed.*ECONNREFUSED/s);
		const inUrl = await storage(["join", `postgres://atomic:${PASSWORD}@db/atomic`]);
		assert.equal(inUrl.code, 1);
		assert.match(inUrl.err, /credential-in-url/);
		writeFileSync(join(root, "empty"), "\n");
		const empty = await storage(["join", URL_, "--password-file", join(root, "empty")]);
		assert.equal(empty.code, 1);
		assert.match(empty.err, /empty-token/);
		assert.match(empty.err, /--password-file.*The password file .* is empty: write the database password into it/s);
		assert.equal(readFileSync(join(agentDir, "settings.json"), "utf8"), before);
		assert.deepEqual(storageTokenFiles(), []);
		for (const output of [missing, refused, inUrl, empty])
			assert.ok(!`${output.out}${output.err}`.includes(PASSWORD));
	});

	test("a server that does not answer fails the join within its timeout (#4793)", async () => {
		installFakePostgres();
		const before = readFileSync(join(agentDir, "settings.json"), "utf8");
		await assert.rejects(
			joinSharedDatabase(
				{
					url: "postgres://atomic@hang/atomic",
					passwordFile,
					agentDir,
					cwd: project,
					pinLocalSessions: false,
				},
				"cli",
				50,
			),
			(error: Error & { code?: string }) => error.code === "connection-timeout" && !error.message.includes(PASSWORD),
		);
		assert.equal(readFileSync(join(agentDir, "settings.json"), "utf8"), before);
		assert.deepEqual(storageTokenFiles(), []);
	});
});

describe("atomic storage status for a Postgres selection (#4793)", () => {
	function selectPostgres(host: string): void {
		const current = settings();
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				...current,
				storage: {
					adapter: POSTGRES_ADAPTER_PACKAGE,
					options: { url: `postgres://atomic@${host}:5432/atomic?sslmode=verify-full` },
					secrets: { password: { file: passwordFile } },
					prefix: "team_",
				},
			}),
		);
	}

	test("names the server without user or query, checks SELECT 1 and reports its version, never the password (#4793)", async () => {
		const fake = installFakePostgres();
		selectPostgres("db.example.com");
		const status = await collectStorageStatus({ cwd: project, agentDir, probe: true });
		const sessions = status.domains.find((domain) => domain.domain === "sessions");
		assert.equal(
			sessions?.selection,
			`PostgreSQL postgres://db.example.com:5432/atomic via ${POSTGRES_ADAPTER_PACKAGE} (prefix team_)`,
		);
		assert.equal(sessions?.probe?.adapter?.loaded, true);
		assert.equal(sessions?.probe?.connection.status, "ok");
		assert.match(
			sessions?.probe?.connection.detail ?? "",
			/^postgres postgres:\/\/db\.example\.com:5432\/atomic answered in \d+ ms, PostgreSQL 16\.4$/,
		);
		assert.equal(fake.opens()[0]?.password, PASSWORD);
		assert.ok(!JSON.stringify(status).includes(PASSWORD));
		const result = await storage(["status"]);
		assert.ok(!`${result.out}${result.err}`.includes(PASSWORD));
	});

	test("says whether wake-ups arrive through LISTEN or by polling alone, and why (#5103)", async () => {
		installFakePostgres();
		for (const [host, wakeUps] of [
			["wake-listening", "wake-ups: LISTEN/NOTIFY"],
			["wake-connecting", "wake-ups: connecting"],
			[
				"wake-unavailable-pooler",
				"wake-ups: polling only, notifications do not pass the URL's transaction pooler (set listenUrl to a direct endpoint)",
			],
			["wake-unavailable-connection-failed", "wake-ups: polling only, the listen connection failed"],
		] as const) {
			selectPostgres(host);
			const status = await collectStorageStatus({ cwd: project, agentDir, probe: true });
			const detail = status.domains.find((domain) => domain.domain === "sessions")?.probe?.connection.detail ?? "";
			assert.ok(detail.endsWith(`, PostgreSQL 16.4; ${wakeUps}`), detail);
		}
	});

	test("a server that does not answer fails the check within the probe timeout (#4793)", async () => {
		installFakePostgres();
		selectPostgres("hang");
		const started = Date.now();
		const status = await collectStorageStatus({ cwd: project, agentDir, probe: true, probeTimeoutMs: 100 });
		const sessions = status.domains.find((domain) => domain.domain === "sessions");
		assert.equal(sessions?.probe?.connection.status, "failed");
		assert.match(sessions?.probe?.connection.detail ?? "", /^The database did not answer within 0\.1 s/);
		assert.ok(Date.now() - started < 10_000);
	});

	test("a slow adapter load still fails the check within the probe timeout when the server does not answer (#4793)", async () => {
		const SLOW_ADAPTER_LOAD_MS = 500;
		const PROBE_TIMEOUT_MS = 100;
		const fake = installFakePostgres({ loadDelayMs: SLOW_ADAPTER_LOAD_MS });
		selectPostgres("hang");
		const started = Date.now();
		const status = await collectStorageStatus({
			cwd: project,
			agentDir,
			probe: true,
			probeTimeoutMs: PROBE_TIMEOUT_MS,
		});
		const sessions = status.domains.find((domain) => domain.domain === "sessions");
		assert.equal(sessions?.probe?.adapter?.loaded, true);
		assert.equal(sessions?.probe?.connection.status, "failed");
		assert.match(sessions?.probe?.connection.detail ?? "", /^The database did not answer within 0\.1 s/);
		assert.equal(fake.opens().length, 1);
		assert.ok(Date.now() - started < 10_000);
	});
});

describe("Postgres selections in team join and export (#4793)", () => {
	test("team join keeps to libSQL URLs (#4793)", async () => {
		await assert.rejects(
			joinSharedDatabase({ url: URL_, auth: "azure-entra", agentDir, cwd: project, pinLocalSessions: true }, "cli"),
			(error: Error & { code?: string }) => error.code === "unsupported-url",
		);
	});

	test("sessions in a joined Postgres database are not exported unless it is named (#4793)", async () => {
		installFakePostgres();
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ ...settings(), storage: { adapter: POSTGRES_ADAPTER_PACKAGE, options: { url: URL_ } } }),
		);
		const refused = await storage(["export", join(root, "out"), "--sessions"]);
		assert.equal(refused.code, 1);
		assert.match(
			refused.err,
			/atomic storage export works with local session storage, but sessions here use PostgreSQL/,
		);
	});

	test("a named database that cannot be read fails the export instead of exporting nothing (#4793)", async () => {
		installFakePostgres();
		const named = JSON.stringify({
			adapter: POSTGRES_ADAPTER_PACKAGE,
			options: { url: "postgres://atomic@refused/atomic" },
		});
		const result = await storage(["export", join(root, "out"), "--storage", named]);
		assert.equal(result.code, 1);
		assert.match(result.err, /connect ECONNREFUSED/);
		mkdirSync(join(root, "in"));
		const memory = await storage(["import", join(root, "in"), "--storage", '{"path":":memory:"}']);
		assert.equal(memory.code, 1);
		assert.match(memory.err, /keeps nothing/);
		assert.equal(existsSync(join(project, ":memory:")), false);
	});
});
