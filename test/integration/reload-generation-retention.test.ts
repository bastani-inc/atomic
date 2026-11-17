/**
 * `/reload` starts a new generation of every extension of a session and retires the previous one. A retired generation
 * must leave nothing behind that keeps it alive: a session reloaded again and again would otherwise keep every
 * generation, and every module its extensions loaded, for as long as it runs.
 */
import { afterAll, beforeAll, test } from "vitest";
import { createAgentSession } from "../../packages/coding-agent/src/index.js";
import { trackCollection } from "../helpers/collect-garbage.js";
import {
	assertEveryOneCollected,
	createRetentionFixture,
	ENDED_SESSIONS_TIMEOUT_MS,
	quietSettings,
	type RetentionFixture,
} from "../helpers/ended-session-retention.js";

/** Reloads of one session: each starts a new generation of every extension and retires the previous one. */
const RELOADS = 4;

let fixture: RetentionFixture | undefined;
const retired = trackCollection();
let disposeSession: (() => Promise<void>) | undefined;

beforeAll(async () => {
	const current = await createRetentionFixture();
	fixture = current;
	const { session } = await createAgentSession({
		cwd: current.cwd,
		agentDir: current.agentDir,
		modelRuntime: current.modelRuntime,
		model: current.parentModel,
		settingsManager: quietSettings(),
		builtins: { mcp: false, "web-access": false },
	});
	disposeSession = () => session.dispose();
	for (let reload = 0; reload < RELOADS; reload++) {
		retired.track(session.extensionRunner);
		await session.reload();
	}
}, ENDED_SESSIONS_TIMEOUT_MS);

afterAll(async () => {
	await disposeSession?.();
	fixture?.dispose();
});

test(
	"every retired generation's extension runner can be collected while the session goes on",
	async () => {
		await assertEveryOneCollected(retired);
	},
	ENDED_SESSIONS_TIMEOUT_MS,
);
