/**
 * One "node" of the reduced multi-node resume scenarios (#4329), run as its own process with its own agent
 * directory, HOME and Atomic home, sharing only the storage selected by ATOMIC_STORAGE.
 *
 *   record <json>  writes a file through a deterministic model turn, prints {"sessionId"}, then waits to be killed
 *   resume <json>  resumes the session the way `atomic --session <id>` does and prints what it observed
 *   sdk-open <json> opens the session through SDK `createAgentSession({ sessionManager })` and prints where it starts
 *
 * With PROVISION_ARCHIVE set, a node without Git provisions it from that archive (PROVISION_SHA256, PROVISION_VERSION)
 * as Atomic provisions its portable Git, through a fetch that serves the archive for the release host, or answers 503
 * when PROVISION_FAIL=1; every other request, such as one to the shared database, goes out as usual.
 */
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getModel } from "@bastani/pi-ai/compat";
import { parseArgs } from "../../packages/coding-agent/src/cli/args.ts";
import { getAgentDir } from "../../packages/coding-agent/src/config.ts";
import { resumeFailureMessage } from "../../packages/coding-agent/src/core/resume/failure.ts";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { resolveSessionStore } from "../../packages/coding-agent/src/core/session-storage.ts";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.ts";
import { selectProcessStorage } from "../../packages/coding-agent/src/core/storage/process-selection.ts";
import { openCliSession } from "../../packages/coding-agent/src/main-session.ts";
import {
	type GitRelease,
	type GitTargetKey,
	withGitProvisionSettingsForTest,
} from "../../packages/coding-agent/src/utils/tools-manager.ts";
import { createHarness } from "../../packages/coding-agent/test/suite/harness.ts";

interface RecordArgs {
	readonly cwd: string;
	readonly file: string;
	readonly content: string;
	/** A second file the same turn writes, for example in another repository. */
	readonly alsoWrite?: { readonly file: string; readonly content: string };
}

interface SdkOpenArgs {
	readonly sessionId: string;
	/** A file, relative to the session's checkout, whose bytes are printed from where the session starts. */
	readonly readFile: string;
	readonly setupCommand?: string;
}

interface ResumeArgs {
	readonly sessionId: string;
	readonly launchCwd: string;
	readonly readPath: string;
	readonly setupCommand?: string;
	readonly catalogTimeoutMs?: number;
}

function emit(value: object): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function record(args: RecordArgs): Promise<void> {
	const agentDir = getAgentDir();
	selectProcessStorage("sessions", agentDir, args.cwd);
	const store = await resolveSessionStore(args.cwd, { agentDir, settings: {} });
	const sessionManager = await SessionManager.create(store, args.cwd);
	const harness = await createHarness({ sessionManager, cwd: args.cwd });
	const writes = [{ file: args.file, content: args.content }, ...(args.alsoWrite === undefined ? [] : [args.alsoWrite])];
	harness.setResponses([
		fauxAssistantMessage(
			writes.map((write) => fauxToolCall("write", { path: write.file, content: write.content })),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(`wrote ${args.file}`),
	]);
	await harness.session.prompt("write the file");
	emit({ sessionId: sessionManager.getSessionId(), snapshots: sessionManager.getLatestWorktreeSnapshots().size });
	await new Promise(() => {});
}

function writeSetupCommand(agentDir: string, setupCommand: string | undefined): void {
	if (setupCommand === undefined) return;
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ resume: { setupCommand } }));
}

async function sdkOpen(args: SdkOpenArgs): Promise<void> {
	const agentDir = getAgentDir();
	writeSetupCommand(agentDir, args.setupCommand);
	selectProcessStorage("sessions", agentDir, process.cwd());
	const store = await resolveSessionStore(process.cwd(), { agentDir, settings: {} });
	const { session } = await createAgentSession({
		agentDir,
		model: getModel("anthropic", "claude-sonnet-4-5")!,
		settingsManager: SettingsManager.create(process.cwd(), agentDir),
		sessionManager: await SessionManager.open(store, args.sessionId),
	});
	const cwd = session.sessionManager.getCwd();
	emit({
		cwd: realpathSync(cwd),
		mappings: session.sessionManager.getWorktreeRootMappings(),
		readFile: readFileSync(join(cwd, args.readFile), "utf8"),
	});
	await session.dispose();
	await store.close();
}

async function resume(args: ResumeArgs): Promise<void> {
	const agentDir = getAgentDir();
	writeSetupCommand(agentDir, args.setupCommand);
	const parsed = parseArgs(["--session", args.sessionId]);
	const settings = SettingsManager.create(args.launchCwd, agentDir);
	const opened = await openCliSession(parsed, args.launchCwd, settings, {
		agentDir,
		trusted: () => false,
		...(args.catalogTimeoutMs === undefined ? {} : { catalogTimeoutMs: args.catalogTimeoutMs }),
	});
	if (opened === "cancelled") throw new Error("resume was cancelled");
	const { sessionManager, notices } = opened;
	const harness = await createHarness({ sessionManager, cwd: sessionManager.getCwd() });
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("read", { path: args.readPath })], { stopReason: "toolUse" }),
		fauxAssistantMessage("continued"),
	]);
	await harness.session.prompt("read the file you wrote");
	const toolResult = sessionManager
		.getEntries()
		.flatMap((entry) =>
			entry.type === "message" && entry.message.role === "toolResult" ? [entry.message.content] : [],
		)
		.at(-1);
	emit({
		cwd: realpathSync(sessionManager.getCwd()),
		notices,
		mappings: sessionManager.getWorktreeRootMappings(),
		userMessages: sessionManager
			.getEntries()
			.filter((entry) => entry.type === "message" && entry.message.role === "user").length,
		toolResult,
	});
	await harness.cleanup();
	await sessionManager.getSessionStore().close();
}

const TARGETS: readonly GitTargetKey[] = [
	"darwin-x64",
	"darwin-arm64",
	"linux-x64",
	"linux-arm64",
	"linux-arm",
	"win32-x64",
	"win32-arm64",
	"win32-ia32",
];

/** Runs `action` with Git provisioned from PROVISION_ARCHIVE when that is set; see the header. */
async function withProvisioning(action: () => Promise<void>): Promise<void> {
	const archive = process.env.PROVISION_ARCHIVE;
	if (archive === undefined) return action();
	const bytes = new Uint8Array(readFileSync(archive));
	const fail = process.env.PROVISION_FAIL === "1";
	const realFetch = globalThis.fetch;
	const releaseHost = (input: Parameters<typeof fetch>[0]) =>
		new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).hostname ===
		"github.com";
	globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		if (!releaseHost(input)) return realFetch(input, init);
		return fail ? new Response("unavailable", { status: 503 }) : new Response(bytes);
	}, realFetch);
	const asset = { name: "portable-git.tar.gz", sha256: process.env.PROVISION_SHA256 ?? "" };
	const release: GitRelease = {
		repo: "example/portable-git",
		tag: "v0.0.0-multinode",
		version: process.env.PROVISION_VERSION ?? "",
		assets: Object.fromEntries(TARGETS.map((target) => [target, asset])) as GitRelease["assets"],
	};
	return withGitProvisionSettingsForTest({ release }, action);
}

const [command, json] = process.argv.slice(2);
try {
	await withProvisioning(async () => {
		if (command === "record") await record(JSON.parse(json!) as RecordArgs);
		else if (command === "resume") await resume(JSON.parse(json!) as ResumeArgs);
		else if (command === "sdk-open") await sdkOpen(JSON.parse(json!) as SdkOpenArgs);
		else throw new Error(`unknown command ${command}`);
	});
	process.exit(0);
} catch (error) {
	const typed = error as {
		name?: string;
		code?: string;
		message?: string;
		retryable?: boolean;
		subject?: string;
		problems?: readonly { code: string; subject: string }[];
		cause?: { name?: string; code?: string; cause?: { name?: string; code?: string } };
	};
	emit({
		error: {
			name: typed.name,
			code: typed.code,
			message: typed.message,
			retryable: typed.retryable,
			subject: typed.subject,
			rendered: resumeFailureMessage(error),
			problems: typed.problems?.map((problem) => ({ code: problem.code, subject: problem.subject })),
			...(typed.cause === undefined
				? {}
				: {
						cause: {
							name: typed.cause.name,
							code: typed.cause.code,
							...(typed.cause.cause === undefined
								? {}
								: { cause: { name: typed.cause.cause.name, code: typed.cause.cause.code } }),
						},
					}),
		},
	});
	process.exit(2);
}
