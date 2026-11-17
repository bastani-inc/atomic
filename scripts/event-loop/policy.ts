/**
 * What the event-loop check treats as the interactive host, where it starts walking, and the reviewed exceptions.
 *
 * Every entry names a function as `<repository-relative file>#<qualified name>`, the name `check-event-loop.ts --paths`
 * prints after the line of each step and `--explain` takes. An entry that no longer matches a function, or that the
 * walk no longer meets, fails the check, so the policy cannot drift from the code.
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
	{ file: "/@types/node/timers.d.ts", names: ["setTimeout", "setInterval", "setImmediate"] },
	{ file: "/bun-types/globals.d.ts", names: ["setTimeout", "setInterval", "setImmediate"] },
	{ file: ".d.ts", owner: "Promise", names: ["then", "catch", "finally"], continuation: true },
	{ file: "/lib.dom.d.ts", names: ["addEventListener"] },
	{ file: ".ts", names: OUR_REGISTRATION_NAMES },
];

/**
 * Calls whose callback arguments never run while the user interacts: exit handlers, which run as the process exits,
 * and listener removals, which never call the listener they are given.
 */
export const DETACHED_CALLBACKS: readonly SinkSpec[] = [
	{ file: "", owner: "process", names: ["on", "once", "addListener", "prependListener"], events: ["exit"] },
	{ file: "", names: ["off", "removeListener", "removeEventListener"] },
];

export interface OwnedArea {
	/** Repository-relative files, or directories ending in `/`: their calls and every call reached only through them. */
	readonly paths?: readonly string[];
	readonly functions?: readonly FunctionSelector[];
	/** The pull request or work item that makes these calls non-blocking. */
	readonly owner: string;
}

/**
 * Areas another open change is making non-blocking. Their findings are reported, not failed, so the two changes do not
 * collide; remove an entry once its owner has landed and the check passes without it.
 */
export const OWNED_ELSEWHERE: readonly OwnedArea[] = [
	{
		owner: "#5376 (node:sqlite statements off the event loop)",
		paths: ["packages/workflows/src/workers/ship-shard.ts"],
		functions: [
			"databaseNow",
			"NodeSqliteDatabase.tryBegin/this.driver()",
			"NodeSqliteDatabase.dataVersion/this.driver()",
			"NodeSqliteDatabase.createExecutor/statement",
			"NodeSqliteDatabase.createExecutor/<returned>.exec/execute()",
			"NodeSqliteDatabase.createExecutor/<returned>.run/execute()",
			"NodeSqliteDatabase.createExecutor/<returned>.get/execute()",
			"NodeSqliteDatabase.createExecutor/<returned>.all/execute()",
			"NodeSqliteDatabase.close/this.tail.then()/this.driver()",
			"openConnection",
			"openNodeSqliteDatabase",
			"openNodeSqliteDatabase/switchToWriteAheadLog()",
		].map((name) => ({ file: "packages/coding-agent/src/core/storage/node-sqlite.ts", name })),
	},
];

/**
 * Reviewed exceptions: functions the walk reaches from an interactive entry point that run only before the first
 * frame. The walk does not enter them. Each needs the reason it cannot run after the first frame.
 */
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

/**
 * Reviewed exceptions: hooks a synchronous module loader calls while it evaluates an extension's modules (jiti's
 * transform and `require`, which read their files synchronously themselves). They cannot return a promise. Extensions
 * load before the first frame, and again when the user reloads them or opens another session, while the interface
 * shows the reload in progress. Making extension loading itself non-blocking (serving the module graph from an
 * asynchronously read snapshot) is separate work. The walk does not enter them.
 */
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

/**
 * Reviewed exceptions: a small synchronous write whose ordering before the next side effect is a crash-consistency
 * contract: if the process is killed right after it, the record must already be on disk. Only the function's own
 * calls are exempt; the walk still checks everything it calls.
 */
export const DURABLE_RECORDS: readonly ReviewedSelector[] = [
	{
		file: "packages/coding-agent/src/core/resume/blueprint/build-lock.ts",
		name: "writeBuildLocksDurably",
		reason:
			"names a blueprint step's process in its build lock as the step starts and ends, and adds its start once read, so a host killed mid-step always leaves a lock that lets the next resume stop the step's leftovers (#4748)",
	},
];

/**
 * Reviewed exceptions: functions that only run as the process exits or after an error that ends the session, when a
 * blocking write is the only way the record lands. The walk does not enter them.
 */
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
		file: "packages/tui/src/tui-main-screen.ts",
		name: "writeRenderCrashLog",
		reason:
			"writes the dump of a frame wider than the terminal just before the render throws, ending the session; the error names the file, so the write must land first",
	},
];

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

export interface ReviewedEdge {
	readonly from: FunctionSelector;
	readonly to: FunctionSelector;
	readonly reason: string;
}

/**
 * Calls the walk does not follow because the condition guarding them never holds on an interactive path, typically a
 * fallback for an argument every caller in Atomic passes. Each needs the reason, naming those callers.
 */
export const GUARDED_CALLS: readonly ReviewedEdge[] = [
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
