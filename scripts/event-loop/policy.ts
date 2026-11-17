/**
 * What the event-loop check treats as the interactive host, where it starts walking, and the reviewed exceptions.
 *
 * Every entry names a function as `<repository-relative file>#<qualified name>`, the name `check-event-loop.ts --list`
 * prints. An entry that no longer matches a function fails the check, so the policy cannot drift from the code.
 */
import type { SinkSpec } from "./call-graph.ts";

export interface FunctionSelector {
	readonly file: string;
	readonly name: string;
}

export interface ReviewedSelector extends FunctionSelector {
	readonly reason: string;
}

export interface InterfaceRoot {
	readonly file: string;
	readonly type: string;
	readonly members: readonly string[];
	readonly reason: string;
}

const ANALYZED_PREFIXES = [
	"packages/coding-agent/src/",
	"packages/tui/src/",
	"packages/agent/src/",
	"packages/ai/src/",
	"packages/codemode/src/",
	"packages/workflows/src/",
	"packages/workflows/builtin/",
	"packages/subagents/src/",
	"packages/intercom/",
	"packages/mcp/",
	"packages/web-access/",
];

/** Shipped sources of the packages the interactive host loads, without tests or build output. */
export function isAnalyzedFile(path: string): boolean {
	if (!ANALYZED_PREFIXES.some((prefix) => path.startsWith(prefix))) return false;
	if (path.endsWith(".d.ts") || path.endsWith(".test.ts")) return false;
	return !/\/(test|tests|dist|node_modules|fixtures)\//.test(path);
}

/**
 * Where the interactive host's process starts: the CLI entry (which also starts the isolated engine child) and the
 * bundled extensions it loads. Everything they reach can run in the process; callbacks they register run later,
 * from the event loop, and those are the interactive entry points.
 */
export const PROCESS_ENTRIES: readonly FunctionSelector[] = [
	{ file: "packages/coding-agent/src/cli.ts", name: "<module>" },
	{ file: "packages/workflows/src/extension/extension-factory.ts", name: "factory" },
	{ file: "packages/subagents/src/extension/index.ts", name: "registerSubagentExtension" },
	{ file: "packages/intercom/index.ts", name: "intercom" },
	{ file: "packages/mcp/index.ts", name: "mcpExtension" },
	{ file: "packages/web-access/index.ts", name: "webAccess" },
	{ file: "packages/coding-agent/src/extensions/herdr/index.ts", name: "herdrExtension" },
	{ file: "packages/coding-agent/src/extensions/llama/index.ts", name: "llamaExtension" },
	{ file: "packages/coding-agent/src/extensions/codemode/index.ts", name: "<module>" },
	{ file: "packages/coding-agent/src/extensions/mcp/index.ts", name: "<module>" },
	{ file: "packages/coding-agent/src/extensions/tool-search/index.ts", name: "<module>" },
];

/**
 * Modules every interactive process has loaded before its first frame: these and everything they import statically.
 * Importing one of them again later runs nothing, so the walk does not follow `import()` into them.
 */
export const STARTUP_MODULES: readonly string[] = [
	"packages/coding-agent/src/cli.ts",
	"packages/coding-agent/src/main.ts",
	"packages/coding-agent/src/core/http-dispatcher.ts",
	"packages/coding-agent/src/cli/settings-startup.ts",
	"packages/workflows/src/extension/index.ts",
	"packages/subagents/src/extension/index.ts",
	"packages/intercom/index.ts",
	"packages/mcp/index.ts",
	"packages/web-access/index.ts",
];

/** Functions that only run in another command or mode of the CLI, never in an interactive session's process. */
export const OTHER_MODES: readonly ReviewedSelector[] = [];

/**
 * Interactive entry points the registration sinks do not already reach: every component's render and input handlers,
 * which the TUI calls on each frame and key.
 */
export const INTERFACE_ROOTS: readonly InterfaceRoot[] = [
	{
		file: "packages/tui/src/tui.ts",
		type: "Component",
		members: ["render", "handleInput", "handleMouse", "invalidate"],
		reason: "the TUI renders components every frame and routes keys and mouse events to them",
	},
];

const OUR_REGISTRATION_NAMES = [
	"on",
	"once",
	"subscribe",
	"addListener",
	"addInputListener",
	"onTerminalColorSchemeChange",
	"registerTool",
	"registerCommand",
	"registerShortcut",
	"registerMessageRenderer",
	"registerProvider",
	"registerFlag",
	"onDebugSettingChange",
];

/**
 * Registration APIs: a function passed to one of these runs later, when its event arrives, so it is an interactive
 * entry point if the process registered it.
 */
const EMITTER_METHODS = ["on", "once", "addListener", "prependListener", "prependOnceListener"];
const NODE_EMITTER_DECLARATIONS = [
	"events",
	"stream",
	"net",
	"tty",
	"process",
	"child_process",
	"readline",
	"worker_threads",
	"http",
];

export const SINKS: readonly SinkSpec[] = [
	...NODE_EMITTER_DECLARATIONS.map((module) => ({ file: `/@types/node/${module}.d.ts`, names: EMITTER_METHODS })),
	{ file: "/@types/node/fs.d.ts", names: [...EMITTER_METHODS, "watch", "watchFile"] },
	{ file: "/@types/node/timers.d.ts", names: ["setTimeout", "setInterval"] },
	{ file: "/bun-types/globals.d.ts", names: ["setTimeout", "setInterval"] },
	{ file: "/lib.dom.d.ts", names: ["addEventListener"] },
	{ file: ".ts", names: OUR_REGISTRATION_NAMES },
];

/** Callbacks that only run as the process exits, when blocking delays nothing the user waits for. */
export const DETACHED_CALLBACKS: readonly SinkSpec[] = [
	{ file: "", owner: "process", names: ["on", "once", "addListener", "prependListener"], events: ["exit"] },
];

export interface OwnedArea {
	/** Repository-relative files, or directories ending in `/`. */
	readonly paths: readonly string[];
	/** The pull request or work item that makes these calls non-blocking. */
	readonly owner: string;
}

/**
 * Areas another open change is making non-blocking. Their findings are reported, not failed, so the two changes do not
 * collide; remove an entry once its owner has landed and the check passes without it.
 */
export const OWNED_ELSEWHERE: readonly OwnedArea[] = [
	{
		owner: "#5345 (snapshot Git and host spawn)",
		paths: [
			"packages/coding-agent/src/core/worktree-snapshot/",
			"packages/coding-agent/src/core/session-worktree-snapshots.ts",
		],
	},
	{
		owner: "#5339 (startup before the first frame)",
		paths: [
			"packages/coding-agent/src/utils/interactive-engine-bootstrap.ts",
			"packages/coding-agent/src/utils/compile-cache.ts",
			"packages/coding-agent/src/utils/heap-relaunch.ts",
			"packages/coding-agent/src/main-early-input.ts",
			"packages/coding-agent/src/core/models-store.ts",
			"packages/coding-agent/src/utils/shell.ts",
		],
	},
	{
		owner: "checkpoint shard writes off the main thread (the node:sqlite driver)",
		paths: [
			"packages/workflows/src/workers/ship-shard.ts",
			"packages/coding-agent/src/core/storage/node-sqlite.ts",
			"packages/coding-agent/src/core/storage/write-ahead-log.ts",
		],
	},
	{
		owner: "#5285 (Windows private temp directory ACLs and their callers)",
		paths: [
			"packages/coding-agent/src/core/tools/windows-directory-security.ts",
			"packages/coding-agent/src/core/tools/session-temp-dir.ts",
			"packages/coding-agent/src/core/tools/session-temp-cleanup.ts",
			"packages/coding-agent/src/core/bash-executor.ts",
			"packages/coding-agent/src/core/tools/output-accumulator.ts",
			"packages/coding-agent/src/core/tools/oversized-tool-result.ts",
			"packages/coding-agent/src/core/tools/persisted-output-file.ts",
			"packages/coding-agent/src/core/package-manager-paths.ts",
			"packages/coding-agent/src/core/storage/session/released-history-files.ts",
			"packages/subagents/src/shared/artifacts.ts",
			"packages/web-access/github-config.ts",
			"packages/web-access/github-extract.ts",
			"packages/workflows/builtin/",
		],
	},
];

/**
 * Reviewed exceptions: functions the walk reaches from an interactive entry point that run only before the first
 * frame. The walk does not enter them. Each needs the reason it cannot run after the first frame.
 */
export const STARTUP_ONLY: readonly ReviewedSelector[] = [];

export interface ReviewedRegex {
	readonly file: string;
	/** The pattern's source, exactly as the check prints it. */
	readonly pattern: string;
	readonly reason: string;
}

/**
 * Regular expressions on interactive paths that can backtrack super-linearly but only ever see input that is short or
 * the user's own, so they cannot stall the host. Each needs the reason its input stays small.
 */
export const REVIEWED_REGEXES: readonly ReviewedRegex[] = [];

/** Everything the check needs to know about the program it walks. */
export interface EventLoopPolicy {
	readonly isAnalyzedFile: (path: string) => boolean;
	readonly processEntries: readonly FunctionSelector[];
	readonly startupModules: readonly string[];
	readonly otherModes: readonly ReviewedSelector[];
	readonly interfaceRoots: readonly InterfaceRoot[];
	readonly sinks: readonly SinkSpec[];
	readonly detachedCallbacks: readonly SinkSpec[];
	readonly ownedElsewhere: readonly OwnedArea[];
	readonly startupOnly: readonly ReviewedSelector[];
	readonly reviewedRegexes: readonly ReviewedRegex[];
}

export const INTERACTIVE_HOST_POLICY: EventLoopPolicy = {
	isAnalyzedFile,
	processEntries: PROCESS_ENTRIES,
	startupModules: STARTUP_MODULES,
	otherModes: OTHER_MODES,
	interfaceRoots: INTERFACE_ROOTS,
	sinks: SINKS,
	detachedCallbacks: DETACHED_CALLBACKS,
	ownedElsewhere: OWNED_ELSEWHERE,
	startupOnly: STARTUP_ONLY,
	reviewedRegexes: REVIEWED_REGEXES,
};
