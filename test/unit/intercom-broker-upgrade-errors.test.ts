import assert from "node:assert/strict";
import {
	IntercomBrokerError,
	IntercomBrokerProtocolError,
	IntercomBrokerStopTimeoutError,
	IntercomBrokerUpgradeError,
	isIntercomBrokerError,
	isIntercomBrokerProtocolError,
	isIntercomBrokerStopTimeoutError,
	isIntercomBrokerUpgradeError,
	isRetryableIntercomBrokerError,
	rehydrateIntercomBrokerError,
	type SerializedIntercomBrokerError,
	serializeIntercomBrokerError,
} from "@bastani/atomic";
import { describe, test } from "vitest";
import { rehydrateError, serializeError } from "../../packages/workflows/src/shared/error-codec.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

interface MemberCase {
	readonly name: string;
	readonly code: string;
	readonly make: (cause?: Error) => IntercomBrokerError;
	readonly guard: (error: unknown) => boolean;
	readonly type: abstract new (...args: never[]) => IntercomBrokerError;
	readonly fields: Readonly<Record<string, string | number>>;
	readonly retryable: boolean;
	readonly hint: RegExp;
	/** Field values that do not fit the class, each rebuilding the copy as the family base. */
	readonly misfits: readonly Readonly<Record<string, unknown>>[];
}

const PROTOCOL_FIELDS = {
	feature: "reserve_released_children",
	brokerProtocolMin: 1,
	brokerProtocolMax: 1,
	requiredProtocol: 2,
};
const UPGRADE_FIELDS = { phase: "stop", previousPid: 4242, previousProtocolMax: 1 } as const;
const STOP_FIELDS = { pid: 4242, timeoutMs: 10_000, elapsedMs: 10_050 };

const MEMBERS: readonly MemberCase[] = [
	{
		name: "IntercomBrokerProtocolError",
		code: "broker-protocol-unsupported",
		make: (cause) => new IntercomBrokerProtocolError(PROTOCOL_FIELDS, cause === undefined ? undefined : { cause }),
		guard: isIntercomBrokerProtocolError,
		type: IntercomBrokerProtocolError,
		fields: PROTOCOL_FIELDS,
		retryable: false,
		hint: /atomic intercom restart/,
		misfits: [
			{ ...PROTOCOL_FIELDS, feature: 7 },
			{ ...PROTOCOL_FIELDS, brokerProtocolMax: 0 },
			{ ...PROTOCOL_FIELDS, requiredProtocol: 2.5 },
			{ feature: "x" },
		],
	},
	{
		name: "IntercomBrokerUpgradeError",
		code: "broker-upgrade-failed",
		make: (cause) => new IntercomBrokerUpgradeError(UPGRADE_FIELDS, cause === undefined ? undefined : { cause }),
		guard: isIntercomBrokerUpgradeError,
		type: IntercomBrokerUpgradeError,
		fields: UPGRADE_FIELDS,
		retryable: true,
		hint: /older broker, on this machine only/,
		misfits: [
			{ ...UPGRADE_FIELDS, phase: "restart" },
			{ ...UPGRADE_FIELDS, previousPid: -1 },
			{ ...UPGRADE_FIELDS, previousProtocolMax: 0 },
			{ phase: "start" },
		],
	},
	{
		name: "IntercomBrokerStopTimeoutError",
		code: "broker-stop-timeout",
		make: (cause) => new IntercomBrokerStopTimeoutError(STOP_FIELDS, cause === undefined ? undefined : { cause }),
		guard: isIntercomBrokerStopTimeoutError,
		type: IntercomBrokerStopTimeoutError,
		fields: { phase: "stop", ...STOP_FIELDS },
		retryable: true,
		hint: /end it yourself/,
		misfits: [
			{ phase: "start", ...STOP_FIELDS },
			{ phase: "stop", ...STOP_FIELDS, timeoutMs: "10000" },
			{ phase: "stop", ...STOP_FIELDS, pid: 1.5 },
			{ phase: "stop" },
		],
	},
];

describe.each(MEMBERS)("$name (#4538)", (member) => {
	test("carries its code, fields, hint and retryability, and is recognized by its guard and the family's", () => {
		const cause = new Error("lower-level failure");
		const error = member.make(cause);

		assert.ok(error instanceof member.type);
		assert.ok(error instanceof IntercomBrokerError);
		assert.deepEqual([error.name, error.code, error.retryable], [member.name, member.code, member.retryable]);
		assert.deepEqual(error.fields, member.fields);
		for (const [key, value] of Object.entries(member.fields)) {
			assert.equal((error as unknown as Record<string, unknown>)[key], value, key);
		}
		assert.match(error.hint ?? "", member.hint);
		assert.ok(error.message.includes(`(${member.code}). ${error.hint}`), error.message);
		assert.equal(error.cause, cause);
		assert.ok(member.guard(error));
		assert.ok(isIntercomBrokerError(error));
		assert.equal(isRetryableIntercomBrokerError(new Error("wrapped", { cause: error })), member.retryable);
		for (const other of MEMBERS) {
			if (other !== member) assert.equal(other.guard(error), false, other.name);
		}
	});

	test("crosses a process boundary as itself, its cause included", () => {
		const original = member.make(new Error("lower-level failure"));
		const form = JSON.parse(JSON.stringify(serializeIntercomBrokerError(original))) as SerializedIntercomBrokerError;
		assert.deepEqual(form, {
			name: member.name,
			code: member.code,
			message: original.message,
			hint: original.hint,
			retryable: member.retryable,
			fields: member.fields,
		});
		const cause = new Error("lower-level failure");
		const rebuilt = rehydrateIntercomBrokerError(form, cause);
		assert.ok(rebuilt instanceof member.type);
		assert.equal(rebuilt.message, original.message);
		assert.deepEqual(rebuilt.fields, member.fields);
		assert.equal(rebuilt.cause, cause);
		assert.ok(member.guard(rebuilt));

		const crossed = rehydrateError(JSON.parse(JSON.stringify(serializeError(original))));
		assert.ok(crossed instanceof member.type, String(crossed));
		assert.equal(serializeError(original).family, "intercom-broker");
		assert.deepEqual((crossed as IntercomBrokerError).fields, member.fields);
		assert.ok(member.guard(JSON.parse(JSON.stringify(original))));
	});

	test("a copy whose fields do not fit its class rebuilds as the family base, keeping its name and code", () => {
		const form = serializeIntercomBrokerError(member.make());
		for (const fields of member.misfits) {
			const rebuilt = rehydrateIntercomBrokerError({
				...form,
				fields: fields as SerializedIntercomBrokerError["fields"],
			});
			assert.equal(rebuilt.constructor, IntercomBrokerError, JSON.stringify(fields));
			assert.deepEqual([rebuilt.name, rebuilt.code], [member.name, member.code]);
			assert.equal(member.guard(rebuilt), false, JSON.stringify(fields));
			assert.ok(isIntercomBrokerError(rebuilt));
		}
		assert.equal(member.guard({ name: member.name, code: "broker-future" }), false);
		assert.equal(member.guard({ ...JSON.parse(JSON.stringify(member.make())), name: "Error" }), false);
	});
});

test("an upgrade that failed starting the successor says so and points at the reconnect, not at the older broker (#4538)", () => {
	const error = new IntercomBrokerUpgradeError({ phase: "start", previousPid: 9, previousProtocolMax: 1 });
	assert.equal(
		error.message,
		"Could not replace the older Intercom broker (pid 9, protocol 1) while starting its successor (broker-upgrade-failed). Sessions start a broker again when they reconnect; run `atomic intercom restart` if they keep failing.",
	);
});
