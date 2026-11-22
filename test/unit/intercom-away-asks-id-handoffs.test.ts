import assert from "node:assert/strict";
import { test } from "vitest";
import { AwayAsks } from "../../packages/intercom/broker/away-asks.js";
import type { SavedHandoff } from "../../packages/intercom/broker/multinode-router.js";

const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

function handoff(identity: string, at: number, aliasToken?: string): SavedHandoff {
	return {
		identity,
		handoff: `${identity}-handoff`,
		id: `${identity}-id`,
		alias: `${identity}-alias`,
		...(aliasToken === undefined ? {} : { aliasToken }),
		recovery: `${identity}-recovery`,
		at,
	};
}

test("id hand-overs one broker kept are taken over by the next, and the earlier one's later writes change nothing (#5607)", () => {
	let now = 1_000_000;
	const away = new AwayAsks(undefined, () => now);
	assert.deepEqual(away.takeIdHandoffs("broker-a", KEEP_MS), []);
	const a = handoff("a", now, "token-a");
	const b = handoff("b", now);
	away.putIdHandoffs("broker-a", [
		["a", a],
		["b", b],
	]);

	now += 1_000;
	assert.deepEqual(
		away.takeIdHandoffs("broker-b", KEEP_MS).sort((x, y) => x.identity.localeCompare(y.identity)),
		[a, b],
		"the next broker reads them back as kept",
	);
	away.putIdHandoffs("broker-a", [
		["a", undefined],
		["c", handoff("c", now)],
	]);
	away.putIdHandoffs("broker-b", [["b", undefined]]);

	assert.deepEqual(away.takeIdHandoffs("broker-c", KEEP_MS), [a], "only the holder's write landed");
});

test("an identity keeps one id hand-over, its latest, and those older than the keep time are dropped as a broker takes them (#5607)", () => {
	let now = 1_000_000;
	const away = new AwayAsks(undefined, () => now);
	away.takeIdHandoffs("broker-a", KEEP_MS);
	away.putIdHandoffs("broker-a", [["a", handoff("a", now)]]);
	const latest = { ...handoff("a", now + 1), handoff: "a-newer" };
	away.putIdHandoffs("broker-a", [
		["a", latest],
		["old", handoff("old", now - KEEP_MS)],
	]);

	now += 1;
	assert.deepEqual(away.takeIdHandoffs("broker-b", KEEP_MS), [latest]);
});
