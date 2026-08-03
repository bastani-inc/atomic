/**
 * Companion-package detection tests.
 *
 * `detectCompanions` walks pi's command + tool registries and reports
 * which of the four runtime peers (pi-subagents / pi-mcp-adapter /
 * pi-web-access / pi-intercom) are installed. The detection is
 * intentionally best-effort: a hit on any of `pathHints`,
 * `commandHints`, or `toolHints` counts as installed.
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	COMPANIONS,
	type CompanionProbeApi,
	detectCompanions,
} from "../../packages/workflows/src/extension/companions.js";

function makeProbe(opts: {
	commands?: Array<{ name: string; sourceInfo?: { path?: string; baseDir?: string } }>;
	tools?: Array<{ name: string; sourceInfo?: { path?: string; baseDir?: string } }>;
}): CompanionProbeApi {
	return {
		getCommands: opts.commands ? () => opts.commands! : undefined,
		getAllTools: opts.tools ? () => opts.tools! : undefined,
	};
}

function statusFor(name: string, statuses: ReturnType<typeof detectCompanions>) {
	const status = statuses.find((s) => s.companion.name === name);
	if (!status) throw new Error(`expected status for companion ${name}`);
	return status;
}

describe("detectCompanions — empty pi", () => {
	test("reports every companion as missing when the registries are empty", () => {
		const statuses = detectCompanions(makeProbe({ commands: [], tools: [] }));
		assert.equal(statuses.length, COMPANIONS.length);
		for (const status of statuses) {
			assert.equal(status.installed, false, `${status.companion.name} should be missing`);
			assert.equal(status.evidence, undefined);
		}
	});

	test("absent getCommands / getAllTools doesn't throw — best-effort", () => {
		const statuses = detectCompanions({} as CompanionProbeApi);
		assert.equal(statuses.length, COMPANIONS.length);
		for (const status of statuses) {
			assert.equal(status.installed, false);
		}
	});

	test("getCommands that throws is treated as 'no commands available'", () => {
		const probe: CompanionProbeApi = {
			getCommands: () => {
				throw new Error("boom");
			},
		};
		const statuses = detectCompanions(probe);
		assert.equal(statuses.length, COMPANIONS.length);
		for (const status of statuses) assert.equal(status.installed, false);
	});
});

describe("detectCompanions — path hints (preferred)", () => {
	test("npm-installed pi-subagents is detected via its baseDir path", () => {
		const probe = makeProbe({
			commands: [
				{
					name: "some-command",
					sourceInfo: {
						path: "/home/user/.atomic/npm/node_modules/pi-subagents/src/extension/index.ts",
						baseDir: "/home/user/.atomic/npm/node_modules/pi-subagents",
					},
				},
			],
		});
		const sub = statusFor("pi-subagents", detectCompanions(probe));
		assert.equal(sub.installed, true);
		// Evidence is `path <shortened-from-node_modules slice>`.
		assert.match(sub.evidence ?? "", /^path pi-subagents\b/);
	});

	test("local-checkout install (~/.atomic/extensions/<name>) is detected via path", () => {
		const probe = makeProbe({
			commands: [
				{
					name: "anything",
					sourceInfo: {
						path: "/home/user/.atomic/extensions/pi-mcp-adapter/index.ts",
					},
				},
			],
		});
		const mcp = statusFor("pi-mcp-adapter", detectCompanions(probe));
		assert.equal(mcp.installed, true);
		assert.match(mcp.evidence ?? "", /^path extensions\/pi-mcp-adapter\b/);
	});

	test("unrelated paths don't false-positive a companion", () => {
		const probe = makeProbe({
			commands: [
				{
					name: "review",
					sourceInfo: { path: "/some/random/extension/path/index.ts" },
				},
			],
		});
		const statuses = detectCompanions(probe);
		for (const status of statuses) {
			assert.equal(status.installed, false, `${status.companion.name} should not match unrelated path`);
		}
	});
});

describe("detectCompanions — command-name hints (fallback)", () => {
	test("pi-subagents is detected via /subagents-doctor when no path hint is present", () => {
		const probe = makeProbe({
			commands: [{ name: "subagents-doctor", sourceInfo: { path: "/elsewhere/pkg/index.ts" } }],
		});
		const sub = statusFor("pi-subagents", detectCompanions(probe));
		assert.equal(sub.installed, true);
		assert.equal(sub.evidence, "command /subagents-doctor");
	});

	test("pi-mcp-adapter is detected via /mcp command-name hint", () => {
		const probe = makeProbe({ commands: [{ name: "mcp" }] });
		const mcp = statusFor("pi-mcp-adapter", detectCompanions(probe));
		assert.equal(mcp.installed, true);
		assert.equal(mcp.evidence, "command /mcp");
	});
});

describe("detectCompanions — tool-name hints (fallback)", () => {
	test("pi-subagents is detected via the registered `subagent` tool", () => {
		const probe = makeProbe({
			commands: [],
			tools: [{ name: "subagent" }],
		});
		const sub = statusFor("pi-subagents", detectCompanions(probe));
		assert.equal(sub.installed, true);
		assert.equal(sub.evidence, "tool subagent");
	});

	test("pi-intercom is detected via `contact_supervisor` tool registered by child agents", () => {
		const probe = makeProbe({
			tools: [{ name: "contact_supervisor" }],
		});
		const intercom = statusFor("pi-intercom", detectCompanions(probe));
		assert.equal(intercom.installed, true);
		assert.equal(intercom.evidence, "tool contact_supervisor");
	});
});

describe("detectCompanions — output ordering", () => {
	test("preserves the COMPANIONS catalogue order regardless of registry order", () => {
		const probe = makeProbe({
			commands: [{ name: "subagents-doctor" }, { name: "mcp" }],
			tools: [{ name: "contact_supervisor" }],
		});
		const statuses = detectCompanions(probe);
		assert.deepEqual(
			statuses.map((s) => s.companion.name),
			COMPANIONS.map((c) => c.name),
		);
	});
});
