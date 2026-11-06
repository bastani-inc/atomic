import { describe, test } from "vitest";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import { assert } from "./executor-shared.js";
import { type Ci, makeRig, storeUnavailable, until } from "./waiting-stage-controller-rig.js";

useTemporaryAgentDir();

function detachingOne(ci: Ci) {
	return (number: number, text: string) => (number === 1 && text === "go" ? [ci.call("c1")] : []);
}

describe("what evicting a stage's run finds of the stage (#4373)", () => {
	test("a stage that was never called holds nothing, and waits on nothing (#4373)", () => {
		const rig = makeRig();
		assert.equal(rig.ctx.__evictionState?.(), "passive");
		assert.equal(rig.ctx.__waitingOn?.(), undefined);
	});

	test("a stage waiting released on a detached call waits on that call with the session it gave up (#4373)", async () => {
		const rig = makeRig({ detachOnPrompt: (number, text, ci) => detachingOne(ci)(number, text) });
		const turn = rig.ctx.prompt("go");
		await until(() => rig.log.includes("enter:tool"));

		assert.equal(rig.ctx.__evictionState?.(), "waiting-on-tool");
		const waiting = rig.ctx.__waitingOn?.();
		assert.deepEqual(
			waiting?.calls.map((call) => call.toolCallId),
			["c1"],
		);
		assert.equal(waiting?.sessionId, rig.ctx.sessionId);

		rig.ci.finish("c1");
		await turn;
		assert.equal(rig.ctx.__evictionState?.(), "busy", "a stage with its session reopened is resident again");
		assert.equal(rig.ctx.__waitingOn?.(), undefined);
	});

	test("a stage released between turns holds nothing and waits on no call; one with its session live is busy (#4373)", async () => {
		const resident = makeRig({ policy: undefined });
		await resident.ctx.prompt("hello");
		assert.equal(resident.ctx.__evictionState?.(), "busy");
		assert.equal(resident.ctx.__waitingOn?.(), undefined);

		const released = makeRig();
		await released.ctx.prompt("hello");
		await released.ctx.release();
		assert.equal(released.ctx.__isReleased?.(), true);
		assert.equal(released.ctx.__evictionState?.(), "passive");
		assert.equal(released.ctx.__waitingOn?.(), undefined, "its session is released, but no call is waited on");
	});

	test("a disposed stage holds nothing, even with a session it never gave up (#4373)", async () => {
		const rig = makeRig({ policy: undefined });
		await rig.ctx.prompt("hello");
		assert.equal(rig.ctx.__evictionState?.(), "busy");
		await rig.ctx.__dispose?.();
		assert.equal(rig.ctx.__evictionState?.(), "passive");
	});

	test("a stage reopening its session keeps its run resident, even while it waits to try again (#4373)", async () => {
		const rig = makeRig({ failCreation: (number) => (number === 2 ? storeUnavailable() : undefined) });
		await rig.ctx.prompt("hello");
		await rig.ctx.release();
		assert.equal(rig.ctx.__evictionState?.(), "passive");

		const again = rig.ctx.prompt("again");
		await until(() => rig.log.includes("reopenFailed:release"));
		assert.equal(rig.ctx.__isReleased?.(), true, "the first attempt failed and the stage holds no session");
		assert.equal(rig.ctx.__evictionState?.(), "busy");

		await again;
		assert.equal(rig.created(), 3);
		assert.equal(rig.ctx.__evictionState?.(), "busy");
	});

	test("a stage released between turns that is paused is resident until it is resumed (#4373)", async () => {
		const rig = makeRig();
		await rig.ctx.prompt("hello");
		await rig.ctx.release();
		assert.equal(rig.ctx.__evictionState?.(), "passive");

		const paused = rig.ctx.__requestPause?.();
		await until(() => rig.ctx.__isPaused?.() === true);
		assert.equal(rig.ctx.__evictionState?.(), "busy");
		void paused?.catch(() => {});
		await rig.ctx.__dispose?.();
	});
});
