import assert from "node:assert/strict";
import { test } from "vitest";
import { createEventBus } from "../src/core/event-bus.js";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.js";
import { ExtensionRunner } from "../src/core/extensions/runner.js";
import { noOpUIContext } from "../src/core/extensions/runner-ui.js";
import { SessionManager } from "../src/core/session-manager.js";
import { AgentTaskHost } from "../src/core/tasks/agent-adapter.js";
import { createHerdrExtension } from "../src/extensions/herdr/index.js";
import { arg, fakeHerdr } from "./helpers/herdr.js";

// Supervised shell execution is currently a POSIX host path.
test.runIf(process.platform !== "win32").each([undefined, "child-session"])(
	"Herdr keeps a shell from %s working until native settlement (#5342)",
	async (launchedBy) => {
		const fake = await fakeHerdr();
		const runtime = createExtensionRuntime();

		const session = SessionManager.inMemory();
		const host = new AgentTaskHost({
			scope: { kind: "session", sessionId: session.getSessionId() },
			authorizeLaunch() {},
		});
		const extension = await loadExtensionFromFactory(
			createHerdrExtension({ env: fake.env, enabled: () => true }),
			fake.dir,
			createEventBus(),
			runtime,
			"herdr",
		);
		const runner = new ExtensionRunner([extension], runtime, fake.dir, session, {} as never);
		runner.bindTaskHost(() => host);
		runner.setUIContext({ ...noOpUIContext }, "tui");
		try {
			await runner.emit({ type: "session_start" });
			await fake.waitFor(1);
			const { supervisor, owner } = host.ownerBinding;
			const started = await supervisor.startCommandTask(
				owner,
				{ kind: "command", command: "cat", terminal: { kind: "pipe" }, launchedBy },
				"shell",
			);
			assert.ok(started.ok);
			const observed = await supervisor.initialObservation(started.value, { kind: "background" });
			assert.ok(observed.ok && observed.value.kind === "yielded");
			assert.equal(arg((await fake.waitFor(2))[1].args, "--state"), "working");
			await runner.emit({ type: "agent_settled" });
			assert.equal(arg((await fake.waitFor(3))[2].args, "--state"), "working");
			const input = supervisor.taskStdin(started.value);
			assert.ok(input.ok);
			assert.ok((await supervisor.writeTaskInput(input.value, "eof", { kind: "eof" })).ok);
			assert.equal(arg((await fake.waitFor(4))[3].args, "--state"), "idle");
		} finally {
			await runner.emit({ type: "session_shutdown", reason: "quit" });
			runner.invalidate();
			await host.close("session-close");
			await fake.dispose();
		}
	},
);
