import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.js";

const model = { provider: "provider", id: "family/model" };
const key = "provider/family/model";
const defaults = { enabled: true, reserveTokens: 16384, preserve_recent: 2, compression_ratio: 0.5 };

// Regression coverage for upstream #8133, adapted to Atomic's exact-message tail.
describe("compaction model overrides", () => {
	it("resolves fields independently using exact provider/model keys", () => {
		const manager = SettingsManager.inMemory({
			compaction: {
				reserveTokens: 8192,
				compression_ratio: 0.3,
				query: " focus ",
				modelOverrides: { [key]: { preserve_recent: 0 }, "provider/*": { reserveTokens: 1 } },
			},
		});
		assert.deepEqual(SettingsManager.inMemory().getCompactionSettings(model), defaults);
		assert.deepEqual(manager.getCompactionSettings(model), {
			...defaults,
			reserveTokens: 8192,
			preserve_recent: 0,
			compression_ratio: 0.3,
			query: "focus",
		});
		for (const other of [
			undefined,
			{ provider: "other", id: model.id },
			{ provider: model.provider, id: "family/Model" },
		]) {
			assert.equal(manager.getCompactionPreserveRecent(other), 2);
			assert.equal(manager.getCompactionReserveTokens(other), 8192);
		}
		manager.applyOverrides({ compaction: { modelOverrides: { [key]: { reserveTokens: 0 } } } });
		assert.equal(manager.getCompactionReserveTokens(model), 0);
		assert.equal(manager.getCompactionPreserveRecent(model), 0);
	});

	it("merges project overrides per field and preserves them across toggle saves and reload", async () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () =>
			JSON.stringify({
				compaction: {
					reserveTokens: 8192,
					modelOverrides: {
						[key]: { reserveTokens: 40000, preserve_recent: 3 },
						"provider/other": { preserve_recent: 4 },
					},
				},
			}),
		);
		storage.withLock("project", () =>
			JSON.stringify({ compaction: { modelOverrides: { [key]: { preserve_recent: 1 } } } }),
		);
		const manager = SettingsManager.fromStorage(storage);
		assert.deepEqual(manager.getCompactionSettings(model), { ...defaults, reserveTokens: 40000, preserve_recent: 1 });
		assert.equal(manager.getCompactionPreserveRecent({ provider: "provider", id: "other" }), 4);
		manager.setCompactionEnabled(false);
		await manager.flush();
		await manager.reload();
		assert.deepEqual(manager.getCompactionSettings(model), {
			...defaults,
			enabled: false,
			reserveTokens: 40000,
			preserve_recent: 1,
		});
		manager.setProjectTrusted(false);
		assert.equal(manager.getCompactionPreserveRecent(model), 3);
	});

	for (const field of ["reserveTokens", "preserve_recent"] as const) {
		for (const value of [null, -1, 1.5, "12", true, {}, [], Number.MAX_SAFE_INTEGER + 1]) {
			it(`rejects invalid ${field} value ${JSON.stringify(value)} at either level`, () => {
				const storage = new InMemorySettingsStorage();
				storage.withLock("global", () =>
					JSON.stringify({ compaction: { modelOverrides: { [key]: { [field]: value } } } }),
				);
				assert.throws(
					() => SettingsManager.fromStorage(storage).getCompactionSettings(model),
					/Expected a non-negative safe integer/,
				);
				assert.deepEqual(SettingsManager.fromStorage(storage).getCompactionSettings(), defaults);
				storage.withLock("global", () =>
					JSON.stringify({ compaction: { [field]: value, modelOverrides: { [key]: { [field]: 1 } } } }),
				);
				assert.throws(
					() => SettingsManager.fromStorage(storage).getCompactionSettings(model),
					/Expected a non-negative safe integer/,
				);
			});
		}
		it(`rejects non-finite ${field} values`, () => {
			for (const value of [NaN, Infinity, -Infinity]) {
				const manager = SettingsManager.inMemory({ compaction: { modelOverrides: { [key]: { [field]: value } } } });
				assert.throws(() => manager.getCompactionSettings(model), /Expected a non-negative safe integer/);
			}
		});
	}
	it("rejects malformed matching entries only", () => {
		for (const entry of [null, false, 42, "invalid", []]) {
			const storage = new InMemorySettingsStorage();
			storage.withLock("global", () => JSON.stringify({ compaction: { modelOverrides: { [key]: entry } } }));
			const manager = SettingsManager.fromStorage(storage);
			assert.throws(() => manager.getCompactionSettings(model), /Expected an object/);
			assert.deepEqual(manager.getCompactionSettings(), defaults);
		}
	});
});

describe("compaction planning time limit", () => {
	it("parses durations, turns off only at 0 or disabled, and keeps a fractional millisecond a limit (#4198)", () => {
		const cases: Array<[number | string | undefined, number | undefined]> = [
			[undefined, 300_000],
			[0, undefined],
			["disabled", undefined],
			["5m", 300_000],
			["90s", 90_000],
			[1500, 1500],
			[0.4, 1],
			[-1, 300_000],
			["bogus", 300_000],
			["", 300_000],
		];
		for (const [planningTimeoutMs, expected] of cases) {
			const manager = SettingsManager.inMemory(
				planningTimeoutMs === undefined ? {} : { compaction: { planningTimeoutMs } },
			);
			assert.equal(manager.getCompactionPlanningTimeoutMs(), expected, JSON.stringify(planningTimeoutMs));
		}
	});
});

describe("compaction history recall setting", () => {
	it("is on by default and off only when compaction.historyRecall is false (#4568)", () => {
		assert.equal(SettingsManager.inMemory().getCompactionHistoryRecall(), true);
		assert.equal(SettingsManager.inMemory({ compaction: {} }).getCompactionHistoryRecall(), true);
		assert.equal(
			SettingsManager.inMemory({ compaction: { historyRecall: true } }).getCompactionHistoryRecall(),
			true,
		);
		assert.equal(
			SettingsManager.inMemory({ compaction: { historyRecall: false } }).getCompactionHistoryRecall(),
			false,
		);
	});
});
