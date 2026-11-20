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
	"packages/subagents/src/",
	"packages/intercom/",
	"packages/mcp/",
	"packages/web-access/",
];

export function isAnalyzedFile(path: string): boolean {
	if (!ANALYZED_PREFIXES.some((prefix) => path.startsWith(prefix))) return false;
	if (path.endsWith(".d.ts") || path.endsWith(".test.ts")) return false;
	return !/\/(test|tests|dist|node_modules|fixtures)\//.test(path);
}

export const PROCESS_ENTRIES: readonly FunctionSelector[] = [
	{ file: "packages/coding-agent/src/cli.ts", name: "<module>" },
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

export const STARTUP_MODULES: readonly string[] = [
	"packages/coding-agent/src/cli.ts",
	"packages/coding-agent/src/main.ts",
	"packages/coding-agent/src/core/http-dispatcher.ts",
	"packages/coding-agent/src/cli/settings-startup.ts",
	"packages/subagents/src/extension/index.ts",
	"packages/intercom/index.ts",
	"packages/mcp/index.ts",
	"packages/web-access/index.ts",
];

export const OTHER_MODES: readonly ReviewedSelector[] = [
	{
		file: "packages/intercom/broker/broker.ts",
		name: "IntercomBroker.handleConnection/createMessageReader()",
		reason:
			"IntercomBroker runs only in the detached broker process. The host reaches this message callback only because the host's client and the broker share createMessageReader, whose returned reader calls whichever callback its caller passed",
	},
	{
		file: "packages/intercom/broker/broker.ts",
		name: "IntercomBroker.handleConnection/createMessageReader()#2",
		reason: "the broker's error callback for the same shared reader; it only runs in the detached broker process",
	},
	{
		file: "packages/coding-agent/src/cli/project-trust.ts",
		name: "untrustedProjectSettingsWarning",
		reason:
			"only print, JSON and RPC modes outside the interactive engine call it; the interactive host and engine return before it",
	},
];

export const INTERFACE_ROOTS: readonly InterfaceRoot[] = [
	{
		file: "packages/tui/src/tui.ts",
		type: "Component",
		members: ["render", "handleInput", "handleMouse", "invalidate"],
		reason: "the TUI renders components every frame and routes keys and mouse events to them",
	},
];

/**
 * Functions that run on every request the interactive host sends its engine. The engine reaches them through a
 * handler the RPC mode builds once and hands to its input reader, a path the call graph does not follow.
 */
export const INTERACTIVE_ROOTS: readonly ReviewedSelector[] = [
	{
		file: "packages/coding-agent/src/modes/rpc/rpc-command-handler.ts",
		name: "createRpcCommandHandler/handleCommand",
		reason: "the interactive engine runs every command the host sends, such as a prompt or a model change, here",
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
	{ file: "/@types/node/timers.d.ts", names: ["setTimeout", "setInterval", "setImmediate"] },
	{ file: "/bun-types/globals.d.ts", names: ["setTimeout", "setInterval", "setImmediate"] },
	{ file: ".d.ts", owner: "Promise", names: ["then", "catch", "finally"], continuation: true },
	{ file: "/lib.dom.d.ts", names: ["addEventListener"] },
	{ file: ".ts", names: OUR_REGISTRATION_NAMES },
];

export const DETACHED_CALLBACKS: readonly SinkSpec[] = [
	{ file: "", owner: "process", names: ["on", "once", "addListener", "prependListener"], events: ["exit"] },
	{ file: "", names: ["off", "removeListener", "removeEventListener"] },
];

export interface OwnedArea {
	readonly paths?: readonly string[];
	readonly functions?: readonly FunctionSelector[];
	readonly sampledCallersOfOwnedCalls?: readonly FunctionSelector[];
	readonly owner: string;
}

export const OWNED_ELSEWHERE: readonly OwnedArea[] = [];

export const STARTUP_ONLY: readonly ReviewedSelector[] = [
	{
		file: "packages/coding-agent/src/core/builtin-packages.ts",
		name: "discoverBuiltinPackages",
		reason:
			"the synchronous fallback when the builtin package cache is empty; the cache is filled before the first frame by the discovery the module starts when it loads and by createAgentSessionServices",
	},
	{
		file: "packages/coding-agent/src/modes/interactive/theme/theme-loading.ts",
		name: "readBuiltinThemes",
		reason:
			"runs on the first theme lookup, which initTheme makes before the first frame; later lookups are served from memory",
	},
	{
		file: "packages/coding-agent/src/modes/interactive/theme/theme-loading.ts",
		name: "readCustomThemeFiles",
		reason:
			"runs on the first theme lookup, which initTheme makes before the first frame; /settings and the theme watcher refresh custom themes asynchronously after that",
	},
	{
		file: "packages/coding-agent/src/cli/startup-ui.ts",
		name: "createStartupTui",
		reason:
			"the terminal for first-time setup and the startup trust prompt, mounted before the interactive TUI exists; extension commands reach it only through the ui.select interface, whose interactive implementation is the one they run with",
	},
	{
		file: "packages/coding-agent/src/main-session.ts",
		name: "createResumeProgress/createStartupProgress()",
		reason:
			"writes the resume progress of a command-line resume to the terminal before the TUI paints; startup ends it before interactive mode starts",
	},
];

export const SYNCHRONOUS_LOADER_HOOKS: readonly ReviewedSelector[] = [
	{
		file: "packages/coding-agent/src/core/extensions/loader-virtual-modules.ts",
		name: "installReadFileSyncObserver",
		reason:
			"installs the stand-in for fs.readFileSync that jiti calls while it reads an extension's files, recording what it read for the module graph cache; it keeps the original to call and adds no read of its own",
	},
	{
		file: "packages/coding-agent/src/core/extensions/ts-source-specifiers.ts",
		name: "typeScriptSourceSpecifier",
		reason:
			"jiti's synchronous transform asks it which TypeScript source a .js import names while it evaluates a module",
	},
	{
		file: "packages/coding-agent/src/core/extensions/ts-source-specifiers.ts",
		name: "readCached",
		reason: "reads the transform cache inside jiti's synchronous transform of a module",
	},
	{
		file: "packages/coding-agent/src/core/extensions/reloadable-scripts.ts",
		name: "evaluate",
		reason: "jiti's synchronous require of a reloadable script reads its source as the module is evaluated",
	},
	{
		file: "packages/coding-agent/src/core/extensions/reloadable-scripts.ts",
		name: "packageTypeOf",
		reason: "decides CommonJS or ESM for a module jiti is requiring synchronously from its nearest package.json",
	},
];

export const DURABLE_RECORDS: readonly ReviewedSelector[] = [
	{
		file: "packages/coding-agent/src/core/resume/blueprint/build-lock.ts",
		name: "writeBuildLocksDurably",
		reason:
			"names a blueprint step's process in its build lock as the step starts and ends, and adds its start once read, so a host killed mid-step always leaves a lock that lets the next resume stop the step's leftovers (#4748)",
	},
];

export const EXIT_ONLY: readonly ReviewedSelector[] = [
	{
		file: "packages/coding-agent/src/core/tasks/supervisor.ts",
		name: "killSupervisedProcessTrees",
		reason:
			"only the interactive mode's emergency terminal exit and uncaught-crash handler call it, immediately before process.exit, so supervised process trees die with the process",
	},
	{
		file: "packages/coding-agent/src/core/event-loop-monitor.ts",
		name: "EventLoopMonitor.writeAtQuit",
		reason:
			"the opt-in event-loop diagnostic's last records, written once the quit has begun or at exit; Windows ends the engine as soon as its host quits, before an asynchronous write could land",
	},
	{
		file: "packages/coding-agent/src/core/lifecycle-timings.ts",
		name: "flushLifecycleTraceAtQuit",
		reason:
			"the opt-in startup trace's lines still waiting for the writer's thread, written once the engine's quit has begun; Windows ends the engine as soon as its host has the quit acknowledgement, before an asynchronous write could land",
	},
	{
		file: "packages/tui/src/tui-main-screen.ts",
		name: "writeRenderCrashLog",
		reason:
			"writes the dump of a frame wider than the terminal just before the render throws, ending the session; the error names the file, so the write must land first",
	},
];

export interface ReviewedRegex {
	readonly file: string;
	readonly pattern: string;
	readonly reason: string;
}

export const REVIEWED_REGEXES: readonly ReviewedRegex[] = [];

export interface ReviewedEdge {
	readonly from: FunctionSelector;
	readonly to: FunctionSelector;
	readonly reason: string;
}

export const GUARDED_CALLS: readonly ReviewedEdge[] = [
	{
		from: { file: "packages/coding-agent/src/core/storage/node-sqlite.ts", name: "send" },
		to: { file: "packages/coding-agent/src/core/storage/node-sqlite.ts", name: "CallerThreadConnection.request" },
		reason:
			"statements run on the calling thread only for an in-memory database, which has no file to wait for and no lock another connection holds, and for a connection its caller opened and passed to wrapNodeSqliteDatabase, a DatabaseSync that cannot move to another thread; openNodeSqliteDatabase runs every connection to a file on a thread of its own (#5376)",
	},
	{
		from: { file: "packages/coding-agent/src/core/storage/node-sqlite.ts", name: "NodeSqliteDatabase.besideHolds" },
		to: { file: "packages/coding-agent/src/core/storage/node-sqlite-file-gate.ts", name: "modeOf" },
		reason:
			"prepares and lists the plan of a call's statement, and the connection's functions, on a connection passed to wrapNodeSqliteDatabase, which runs on the calling thread anyway, only while a threaded transaction of this thread holds its file: it does not run the statement or wait for the file's write lock (#6081)",
	},
	{
		from: {
			file: "packages/coding-agent/src/core/storage/node-sqlite-file-gate.ts",
			name: "runDeferred/Promise()/waiter.tryRun",
		},
		to: { file: "packages/coding-agent/src/core/storage/node-sqlite-file-gate.ts", name: "modeOf" },
		reason:
			"decides, at its turn, how a call made while an earlier call of its connection waits runs: lists the plan of its statement and reads settings of a connection passed to wrapNodeSqliteDatabase, which runs on the calling thread anyway, only while a threaded transaction of this thread holds its file: it does not run the statement or wait for the file's write lock (#6081)",
	},
	{
		from: {
			file: "packages/coding-agent/src/core/storage/node-sqlite-file-gate.ts",
			name: "runDeferred/Promise()/waiter.tryRun",
		},
		to: { file: "packages/coding-agent/src/core/storage/node-sqlite-file-gate.ts", name: "busyTimeoutOf" },
		reason:
			"reads PRAGMA busy_timeout, a setting of the connection that touches no file, on a connection passed to wrapNodeSqliteDatabase, which runs on the calling thread anyway, only while a threaded transaction of this thread holds its file (#6081)",
	},
	{
		from: { file: "packages/coding-agent/src/core/storage/node-sqlite-file-gate.ts", name: "timeoutRestored" },
		to: { file: "packages/coding-agent/src/core/storage/node-sqlite-file-gate.ts", name: "setBusyTimeout" },
		reason:
			"gives a connection passed to wrapNodeSqliteDatabase, which runs on the calling thread anyway, its busy timeout back after a statement ran with a busy timeout of 0: a setting of the connection that touches no file (#6081)",
	},
	{
		from: { file: "packages/coding-agent/src/core/storage/node-sqlite-file-gate.ts", name: "attemptOnce" },
		to: { file: "packages/coding-agent/src/core/storage/node-sqlite-file-gate.ts", name: "setBusyTimeout" },
		reason:
			"sets the busy timeout, a setting of the connection that touches no file, of a connection passed to wrapNodeSqliteDatabase, which runs on the calling thread anyway, around a statement it then runs with a busy timeout of 0, so the statement never waits for a lock on this thread (#6081)",
	},
	{
		from: { file: "packages/coding-agent/src/core/storage/node-sqlite-file-gate.ts", name: "runTryingFirst" },
		to: { file: "packages/coding-agent/src/core/storage/node-sqlite-file-gate.ts", name: "busyTimeoutOf" },
		reason:
			"reads PRAGMA busy_timeout, a setting of the connection that touches no file, on a connection passed to wrapNodeSqliteDatabase, which runs on the calling thread anyway, only while a threaded transaction of this thread holds its file (#6081)",
	},
	{
		from: { file: "packages/coding-agent/src/core/storage/node-sqlite-file-gate.ts", name: "runWhenFree" },
		to: { file: "packages/coding-agent/src/core/storage/node-sqlite-file-gate.ts", name: "busyTimeoutOf" },
		reason:
			"reads PRAGMA busy_timeout, a setting of the connection that touches no file, on a connection passed to wrapNodeSqliteDatabase, which runs on the calling thread anyway, only when a call has to wait for a threaded transaction of this thread on its file (#6081)",
	},
	{
		from: { file: "packages/coding-agent/src/core/storage/node-sqlite-file-gate.ts", name: "sqliteBusyError" },
		to: { file: "packages/coding-agent/src/core/storage/node-sqlite-file-gate.ts", name: "errorShape" },
		reason:
			"opens an in-memory database once per process and fails one statement on it, to read how node:sqlite builds its errors: it has no file, so it never waits for the disk or a lock (#6081)",
	},
	{
		from: { file: "packages/coding-agent/src/core/storage/node-sqlite.ts", name: "openNodeSqliteDatabase" },
		to: { file: "packages/coding-agent/src/core/storage/node-sqlite.ts", name: "openOnCallerThread" },
		reason:
			"opens on the calling thread only a database isInMemoryDatabase proves in memory: it has no file, so opening it never waits for the disk or a lock; every other path, an unreadable URI included, opens on a thread of its own (#5376)",
	},
	{
		from: { file: "packages/coding-agent/src/core/storage/node-sqlite.ts", name: "acquireOpenLock" },
		to: { file: "packages/coding-agent/src/core/storage/node-sqlite.ts", name: "legacySharedOpenLock" },
		reason:
			"takes the open lock on the calling thread, tried once without waiting, only with a native binding older than the one this package ships, which lacks trySharedAdvisoryLockAsync; the shipped binding takes it on a native worker (#5376)",
	},
	{
		from: { file: "packages/coding-agent/src/core/agent-session.ts", name: "AgentSessionBase.constructor" },
		to: { file: "packages/coding-agent/src/utils/shell.ts", name: "isPowerShellAvailable" },
		reason:
			"looks for PowerShell only when the config omits powerShellAvailable; createAgentSession resolves it off the event loop and passes it, so only SDK code that constructs an AgentSession itself takes this call",
	},
	{
		from: { file: "packages/coding-agent/src/core/skill-catalog.ts", name: "getSkillCatalog" },
		to: { file: "packages/coding-agent/src/core/skill-catalog.ts", name: "buildSkillCatalog" },
		reason:
			"builds a catalog only for a resource loader without getSkillCatalog; the default, builtin and mandatory loaders all have one, and createAgentSession wraps any caller's loader in one of them, so only SDK hosts that construct an AgentSession with their own loader take this call",
	},
	{
		from: {
			file: "packages/coding-agent/src/core/mandatory-resource-loader.ts",
			name: "MandatoryResourceLoader.getSkillCatalog",
		},
		to: { file: "packages/coding-agent/src/core/skill-catalog.ts", name: "buildSkillCatalog" },
		reason:
			"the fallback for a delegate without getSkillCatalog; the mandatory loader's delegate is always the default or builtin loader, which have one",
	},
	{
		from: {
			file: "packages/coding-agent/src/core/resource-loader-core.ts",
			name: "DefaultResourceLoader.constructor",
		},
		to: { file: "packages/coding-agent/src/core/settings-manager-core.ts", name: "SettingsManager.create" },
		reason:
			"reads settings only when the caller passes no settingsManager; every loader Atomic creates passes one (createAgentSessionServices, BuiltinResourceLoader, a reload's candidate), so only SDK code that omits it takes this call",
	},
];

export interface EventLoopPolicy {
	readonly isAnalyzedFile: (path: string) => boolean;
	readonly processEntries: readonly FunctionSelector[];
	readonly startupModules: readonly string[];
	readonly otherModes: readonly ReviewedSelector[];
	readonly interfaceRoots: readonly InterfaceRoot[];
	readonly interactiveRoots: readonly ReviewedSelector[];
	readonly sinks: readonly SinkSpec[];
	readonly detachedCallbacks: readonly SinkSpec[];
	readonly ownedElsewhere: readonly OwnedArea[];
	readonly startupOnly: readonly ReviewedSelector[];
	readonly exitOnly: readonly ReviewedSelector[];
	readonly synchronousLoaderHooks: readonly ReviewedSelector[];
	readonly durableRecords: readonly ReviewedSelector[];
	readonly guardedCalls: readonly ReviewedEdge[];
	readonly reviewedRegexes: readonly ReviewedRegex[];
}

export const INTERACTIVE_HOST_POLICY: EventLoopPolicy = {
	isAnalyzedFile,
	processEntries: PROCESS_ENTRIES,
	startupModules: STARTUP_MODULES,
	otherModes: OTHER_MODES,
	interfaceRoots: INTERFACE_ROOTS,
	interactiveRoots: INTERACTIVE_ROOTS,
	sinks: SINKS,
	detachedCallbacks: DETACHED_CALLBACKS,
	ownedElsewhere: OWNED_ELSEWHERE,
	startupOnly: STARTUP_ONLY,
	exitOnly: EXIT_ONLY,
	synchronousLoaderHooks: SYNCHRONOUS_LOADER_HOOKS,
	durableRecords: DURABLE_RECORDS,
	guardedCalls: GUARDED_CALLS,
	reviewedRegexes: REVIEWED_REGEXES,
};
