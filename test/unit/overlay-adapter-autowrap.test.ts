import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import type { PiCustomOverlayFactoryTui, PiOverlayHandle } from "../../packages/workflows/src/extension/wiring.js";
import type { GraphOverlayPort, OverlayPiSurface } from "../../packages/workflows/src/tui/overlay-adapter.js";
import { bunExecutable } from "../helpers/runtime.js";

const ISOLATED_PROCESS_ENV = "ATOMIC_OVERLAY_AUTOWRAP_ISOLATED";

async function registerIsolatedTests(): Promise<void> {
	// Only ever reached inside the `bun test` child spawned below, where
	// `bun:test`'s module registry is the real one. vitest has no equivalent.
	const { mock } = await import("bun:test");
	class TestComponent {}
	const [{ ScrollView }, { VStack }] = await Promise.all([
		import("@earendil-works/pi-tui/dist/components/scroll-view.js"),
		import("@earendil-works/pi-tui/dist/components/v-stack.js"),
	]);
	mock.module("@earendil-works/pi-tui", () => ({
		Box: TestComponent,
		Editor: TestComponent,
		ScrollView,
		VStack,
		SelectList: TestComponent,
		Text: TestComponent,
		Key: {
			backspace: "\x7f",
			down: "\x1b[B",
			enter: "\r",
			escape: "\x1b",
			left: "\x1b[D",
			right: "\x1b[C",
			up: "\x1b[A",
			ctrl: (key: string) => key,
		},
		decodeKittyPrintable: () => undefined,
		matchesKey: (data: string, key: string) => data === key,
		truncateToWidth: (text: string, width: number) => text.slice(0, width),
		visibleWidth: (text: string) => text.length,
		wrapTextWithAnsi: (text: string) => [text],
	}));

	mock.module("@bastani/atomic", () => ({
		ChatSessionHost: TestComponent,
		keyHint: (key: string) => key,
		keyText: (key: string) => key,
		rawKeyHint: (key: string) => key,
	}));

	const [{ buildGraphOverlayAdapter }, { createStore }] = await Promise.all([
		import("../../packages/workflows/src/tui/overlay-adapter.js"),
		import("../../packages/workflows/src/shared/store.js"),
	]);

	const TERMINAL_AUTOWRAP_ON = "\x1b[?7h";
	const TERMINAL_AUTOWRAP_OFF = "\x1b[?7l";

	interface AdapterHarness {
		adapter: GraphOverlayPort;
		writes: string[];
	}

	function buildHarness(
		platform: NodeJS.Platform = "win32",
		isTTY = true,
		mode: "regular" | "fullscreen" = "regular",
	): AdapterHarness {
		const writes: string[] = [];
		let hidden = false;
		let focused = true;
		const handle: PiOverlayHandle = {
			hide: () => {
				hidden = true;
			},
			setHidden: (value) => {
				hidden = value;
			},
			isHidden: () => hidden,
			focus: () => {
				focused = true;
			},
			unfocus: () => {
				focused = false;
			},
			isFocused: () => focused,
		};
		const pi: OverlayPiSurface = {
			ui: {
				custom: (factory, options) => {
					options.onHandle?.(handle);
					const tui: PiCustomOverlayFactoryTui = {
						mode,
						requestRender: () => undefined,
						terminal: { rows: 24, columns: 80 },
					};
					const component = factory(tui, {}, {}, () => undefined);
					if (component instanceof Promise) {
						throw new Error("overlay adapter factory should mount synchronously");
					}
					return undefined;
				},
			},
		};
		const adapter = buildGraphOverlayAdapter(pi, createStore(), {
			terminalOutput: {
				platform,
				isTTY,
				write: (data) => writes.push(data),
			},
		});
		return { adapter, writes };
	}

	function autowrapWrites(writes: string[]): string[] {
		return writes.filter((data) => data === TERMINAL_AUTOWRAP_ON || data === TERMINAL_AUTOWRAP_OFF);
	}

	interface RemoteHarness {
		adapter: GraphOverlayPort;
		localWrites: string[];
		remoteAutowrap: boolean[];
	}

	function buildRemoteHarness(platform: NodeJS.Platform = "win32"): RemoteHarness {
		const localWrites: string[] = [];
		const remoteAutowrap: boolean[] = [];
		let hidden = false;
		let focused = true;
		const handle: PiOverlayHandle = {
			hide: () => {
				hidden = true;
			},
			setHidden: (value) => {
				hidden = value;
			},
			isHidden: () => hidden,
			focus: () => {
				focused = true;
			},
			unfocus: () => {
				focused = false;
			},
			isFocused: () => focused,
		};
		const pi: OverlayPiSurface = {
			ui: {
				custom: (factory, options) => {
					options.onHandle?.(handle);
					// Isolated host: the factory TUI terminal exposes the remote-control
					// capability instead of a writable local process.stdout.
					const tui: PiCustomOverlayFactoryTui = {
						requestRender: () => undefined,
						terminal: {
							rows: 24,
							columns: 80,
							setAutowrap: (enabled) => remoteAutowrap.push(enabled),
						},
					};
					const component = factory(tui, {}, {}, () => undefined);
					if (component instanceof Promise) {
						throw new Error("overlay adapter factory should mount synchronously");
					}
					return undefined;
				},
			},
		};
		const adapter = buildGraphOverlayAdapter(pi, createStore(), {
			terminalOutput: {
				platform,
				isTTY: true,
				write: (data) => localWrites.push(data),
			},
		});
		return { adapter, localWrites, remoteAutowrap };
	}

	describe("workflow overlay remote autowrap control", () => {
		test("routes autowrap through the host capability, never the local stdout seam", () => {
			const { adapter, localWrites, remoteAutowrap } = buildRemoteHarness();

			adapter.open(null);

			assert.deepEqual(localWrites, [], "must not write escape sequences to local stdout in isolated mode");
			assert.deepEqual(remoteAutowrap, [false], "Windows autowrap disabled via host capability");
		});

		test("resets autowrap through the host capability on close", () => {
			const { adapter, localWrites, remoteAutowrap } = buildRemoteHarness();

			adapter.open(null);
			adapter.close();

			assert.deepEqual(localWrites, []);
			assert.deepEqual(remoteAutowrap, [false, true], "autowrap restored on close");
		});

		test("skips autowrap on non-Windows hosts", () => {
			const { adapter, localWrites, remoteAutowrap } = buildRemoteHarness("darwin");

			adapter.open(null);

			assert.deepEqual(localWrites, []);
			assert.deepEqual(remoteAutowrap, [], "autowrap is Windows-only");
		});
	});

	describe("workflow overlay terminal autowrap", () => {
		test("disables autowrap when opened on a Windows TTY", () => {
			const { adapter, writes } = buildHarness();

			adapter.open(null);

			assert.deepEqual(autowrapWrites(writes), [TERMINAL_AUTOWRAP_OFF]);
		});
		test("leaves fullscreen terminal modes to pi-tui on the local fallback path", () => {
			const { adapter, writes } = buildHarness("win32", true, "fullscreen");

			adapter.open(null);
			adapter.toggle(null);
			adapter.close();

			assert.deepEqual(writes, [], "fullscreen alt-screen mode must not be disabled by the overlay seam");
		});

		test("restores autowrap once when hidden and does not duplicate on close", () => {
			const { adapter, writes } = buildHarness();

			adapter.open(null);
			adapter.toggle(null);
			adapter.close();
			adapter.close();

			assert.deepEqual(autowrapWrites(writes), [TERMINAL_AUTOWRAP_OFF, TERMINAL_AUTOWRAP_ON]);
		});

		test("restores autowrap once when a visible overlay closes", () => {
			const { adapter, writes } = buildHarness();

			adapter.open(null);
			adapter.close();
			adapter.close();

			assert.deepEqual(autowrapWrites(writes), [TERMINAL_AUTOWRAP_OFF, TERMINAL_AUTOWRAP_ON]);
		});

		test("rapid visibility toggles leave autowrap matching the final state", () => {
			const { adapter, writes } = buildHarness();

			adapter.open(null);
			adapter.toggle(null);
			adapter.toggle(null);
			adapter.toggle(null);

			assert.deepEqual(autowrapWrites(writes), [
				TERMINAL_AUTOWRAP_OFF,
				TERMINAL_AUTOWRAP_ON,
				TERMINAL_AUTOWRAP_OFF,
				TERMINAL_AUTOWRAP_ON,
			]);
		});

		test("keeps the existing terminal byte stream on non-Windows platforms", () => {
			const { adapter, writes } = buildHarness("darwin");

			adapter.open(null);
			adapter.toggle(null);

			assert.deepEqual(writes, []);
		});

		test("writes no terminal controls when stdout is not a TTY", () => {
			const { adapter, writes } = buildHarness("win32", false);

			adapter.open(null);
			adapter.toggle(null);
			adapter.close();

			assert.deepEqual(writes, []);
		});
	});
}

if (process.env[ISOLATED_PROCESS_ENV] === "1") {
	await registerIsolatedTests();
} else {
	test("runs terminal autowrap checks without leaking module mocks", () => {
		const testPath = fileURLToPath(import.meta.url);
		const result = spawnSync(bunExecutable(), ["test", testPath], {
			cwd: process.cwd(),
			env: { ...process.env, [ISOLATED_PROCESS_ENV]: "1" },
			encoding: "utf8",
			timeout: 10_000,
		});

		assert.equal(result.status, 0, result.stderr || result.stdout);
	});
}
