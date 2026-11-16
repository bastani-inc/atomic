import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, test, vi } from "vitest";
import { holderState, hostIdentity } from "../../packages/intercom/broker/stale-lock-file.js";
import { makeDirectorySync, makeTempDirectory, removeTempDirectory, writeTextSync } from "../helpers/runtime.js";

const race = vi.hoisted(() => ({ beforeListing: undefined as (() => void) | undefined }));
vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs")>();
	const readdirSync = ((...args: Parameters<typeof actual.readdirSync>) => {
		const beforeListing = race.beforeListing;
		race.beforeListing = undefined;
		beforeListing?.();
		return actual.readdirSync(...args);
	}) as typeof actual.readdirSync;
	return { ...actual, readdirSync };
});

const tempDir = makeTempDirectory("ic5220-writer-state-");
afterAll(() => removeTempDirectory(tempDir));
afterEach(() => {
	race.beforeListing = undefined;
});

test("a partial holder record from another host keeps its writer's protection after its pid line completes (#5220)", () => {
	const path = join(tempDir, "broker.socket.lock");
	const partial = "2147483646\n";
	writeTextSync(path, partial);
	const stats = statSync(path, { bigint: true });
	writeTextSync(`${path}.writing.2147483646.x.foreign-host.12345678.${stats.ino}-${stats.birthtimeNs}`, "");

	assert.equal(holderState(path, partial), "unknown");
});

test("a dead contender's unbound marker cannot block recovery of an identified dead holder (#5220)", () => {
	const path = join(tempDir, "dead-holder.lock");
	const record = `2147483646\n\n${hostIdentity()}\n`;
	writeTextSync(path, record);
	writeTextSync(`${path}.writing.2147483646.x.${hostIdentity()}.12345678`, "");

	assert.equal(holderState(path, record), "abandoned");
});

test("a dead contender's unbound marker never proves an unidentified file abandoned (#5220)", () => {
	const path = join(tempDir, "unidentified.lock");
	writeTextSync(path, "");
	writeTextSync(`${path}.writing.2147483646.x.${hostIdentity()}.12345678`, "");

	assert.equal(holderState(path, ""), "unknown");
});

test("a generation removed between file inspection and marker listing is retried rather than thrown (#5220)", () => {
	const generation = join(tempDir, "broker.socket.lock.gen1");
	makeDirectorySync(generation);
	const path = join(generation, "owner");
	const record = `2147483646\n\n${hostIdentity()}\n`;
	writeTextSync(path, record);
	race.beforeListing = () => removeTempDirectory(generation);

	assert.equal(holderState(path, record), "held");
});
