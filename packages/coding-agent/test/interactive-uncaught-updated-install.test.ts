import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test, vi } from "vitest";
import { getPackageDir } from "../src/config.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

// The installed package.json reports another version than this process runs: an update replaced the installation.
vi.mock("../src/config.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/config.js")>()),
	detectInstallChangeAsync: async () => ({ kind: "updated", version: "0.10.91" }),
}));

interface Context {
	isShuttingDown: boolean;
	signalCleanupHandlers: Array<() => void>;
	handleTerminalLost: () => void;
	shutdown: () => Promise<void>;
	uncaughtCrash: (error: Error) => never;
	showError: (message: string) => void;
	unregisterSignalHandlers: () => void;
}

interface Prototype {
	registerSignalHandlers(this: Context): void;
	unregisterSignalHandlers(this: Context): void;
}

const prototype = InteractiveMode.prototype as unknown as Prototype;

/** What the interactive host does with `error` thrown past every handler: exit through its crash path, or say why. */
async function uncaught(error: Error): Promise<{ crashed: Error[]; shown: string[] }> {
	const crashed: Error[] = [];
	const shown: string[] = [];
	const context: Context = {
		isShuttingDown: false,
		signalCleanupHandlers: [],
		handleTerminalLost: () => {},
		shutdown: async () => {},
		// The real crash path exits the process; recorded here instead.
		uncaughtCrash: ((crash: Error) => {
			crashed.push(crash);
		}) as Context["uncaughtCrash"],
		showError: (message) => shown.push(message),
		unregisterSignalHandlers: () => prototype.unregisterSignalHandlers.call(context),
	};
	const before = new Set(process.listeners("uncaughtException"));
	prototype.registerSignalHandlers.call(context);
	try {
		const handler = process.listeners("uncaughtException").find((listener) => !before.has(listener));
		assert.ok(handler, "the host registers an uncaught exception handler");
		handler(error, "unhandledRejection");
		await vi.waitFor(() => assert.ok(crashed.length + shown.length > 0));
	} finally {
		context.unregisterSignalHandlers();
	}
	return { crashed, shown };
}

test("a module of the installation that no longer links after an update keeps the session running", async () => {
	const module = pathToFileURL(join(getPackageDir(), "dist/core/export-html/index.js")).href;
	const error = new SyntaxError(
		"The requested module '../../config.js' does not provide an export named 'aNameFromTheFuture'",
	);
	// Node's link error: the stack opens with the importing module's URL and line.
	error.stack = `${module}:1\nimport { aNameFromTheFuture } from "../../config.js";\n         ^\nSyntaxError: ${error.message}`;
	const { crashed, shown } = await uncaught(error);
	assert.deepEqual(crashed, []);
	assert.deepEqual(shown, [
		`atomic was updated to 0.10.91 while this session was running; restart it to keep using this feature.\n${error.message}`,
	]);
});

test("a user extension's missing dependency after an update still ends the session with its own error", async () => {
	const error = Object.assign(
		new Error(
			"Cannot find package 'left-pad-not-installed-atomic' imported from /home/user/.atomic/agent/extensions/missing-dep.mjs",
		),
		{ code: "ERR_MODULE_NOT_FOUND" },
	);
	const { crashed, shown } = await uncaught(error);
	assert.deepEqual(shown, []);
	assert.deepEqual(crashed, [error]);
});

test("any other uncaught error still ends the session", async () => {
	const error = new Error("boom");
	const { crashed, shown } = await uncaught(error);
	assert.deepEqual(shown, []);
	assert.deepEqual(crashed, [error]);
});
