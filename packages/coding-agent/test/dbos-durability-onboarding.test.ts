import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import {
	normalizeAndValidateDbosSystemDatabaseUrl,
	type PostgreSqlValidationClient,
} from "../src/cli/dbos-durability-onboarding.js";

function client(options: { connectError?: Error; queryError?: Error } = {}): PostgreSqlValidationClient {
	return {
		connect: vi.fn(async () => {
			if (options.connectError) throw options.connectError;
		}),
		query: vi.fn(async () => {
			if (options.queryError) throw options.queryError;
		}),
		end: vi.fn(async () => {}),
	};
}

describe("DBOS durability onboarding URL validation", () => {
	test("normalizes whitespace and accepts embedded without opening a connection", async () => {
		const createClient = vi.fn(() => client());
		assert.equal(await normalizeAndValidateDbosSystemDatabaseUrl(" \n ", createClient), "");
		assert.equal(createClient.mock.calls.length, 0);
	});

	test("rejects non-PostgreSQL schemes before connecting", async () => {
		const createClient = vi.fn(() => client());
		await assert.rejects(
			normalizeAndValidateDbosSystemDatabaseUrl("https://database.example/workflows", createClient),
			/PostgreSQL connection URL.*postgres:.*postgresql:/,
		);
		assert.equal(createClient.mock.calls.length, 0);
	});

	test("connects, probes, and closes a trimmed PostgreSQL URL", async () => {
		const validationClient = client();
		const createClient = vi.fn(() => validationClient);
		const url = "postgresql://database.example/workflows";

		assert.equal(await normalizeAndValidateDbosSystemDatabaseUrl(`  ${url}\n`, createClient), url);
		assert.equal(createClient.mock.calls[0]?.[0], url);
		assert.equal(vi.mocked(validationClient.connect).mock.calls.length, 1);
		assert.deepEqual(vi.mocked(validationClient.query).mock.calls[0], ["SELECT 1"]);
		assert.equal(vi.mocked(validationClient.end).mock.calls.length, 1);
	});

	test("closes the client and sanitizes a failed connection", async () => {
		const user = ["onboarding", "user"].join("-");
		const password = ["not", "rendered"].join("-");
		const url = `postgresql://${user}:${password}@database.example/workflows`;
		const validationClient = client({ connectError: new Error(`connection failed for ${url}`) });

		await assert.rejects(
			normalizeAndValidateDbosSystemDatabaseUrl(url, () => validationClient),
			(error: Error) => {
				assert.match(error.message, /database\.example/);
				assert.doesNotMatch(error.message, new RegExp(user));
				assert.doesNotMatch(error.message, new RegExp(password));
				return true;
			},
		);
		assert.equal(vi.mocked(validationClient.end).mock.calls.length, 1);
	});

	test("closes the client when the validation query fails", async () => {
		const validationClient = client({ queryError: new Error("probe failed") });
		await assert.rejects(
			normalizeAndValidateDbosSystemDatabaseUrl("postgres://database.example/workflows", () => validationClient),
			/probe failed/,
		);
		assert.equal(vi.mocked(validationClient.end).mock.calls.length, 1);
	});

	test("times out a hanging validation query and closes the client", async () => {
		vi.useFakeTimers();
		try {
			const validationClient = client();
			validationClient.query = vi.fn(() => new Promise<object>(() => {}));
			const validation = normalizeAndValidateDbosSystemDatabaseUrl(
				"postgresql://database.example/workflows",
				() => validationClient,
			);

			const rejection = assert.rejects(validation, /validation timed out/);
			await vi.advanceTimersByTimeAsync(5_000);
			await rejection;
			assert.equal(vi.mocked(validationClient.end).mock.calls.length, 1);
		} finally {
			vi.useRealTimers();
		}
	});
});
