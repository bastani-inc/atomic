import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
	findImageGenerationError,
	ImageGenerationApiError,
	ImageGenerationConfigError,
	ImageGenerationError,
	type ImageGenerationErrorData,
	ImageGenerationQuotaError,
	ImageGenerationRateLimitError,
	ImageGenerationServerError,
	ImageGenerationTimeoutError,
	ImageGenerationUserError,
	ImageModerationBlockedError,
	imageGenerationErrorFromData,
	isImageGenerationApiError,
	isImageGenerationConfigError,
	isImageGenerationError,
	isImageGenerationQuotaError,
	isImageGenerationRateLimitError,
	isImageGenerationServerError,
	isImageGenerationTimeoutError,
	isImageGenerationUserError,
	isImageModerationBlockedError,
	isRetryableImageGenerationError,
} from "../src/image-generation-error.ts";
import type { ImageModel } from "../src/types.ts";
import { imageErrorResult } from "../src/utils/model-operations.ts";

const apiInit = {
	detail: "provider said no",
	status: 400,
	apiCode: "some_code",
	apiType: "some_type",
	requestId: "req_1",
};

const samples: Array<{
	error: ImageGenerationError;
	name: string;
	code: string;
	retryable: boolean;
	guards: Array<(e: unknown) => boolean>;
}> = [
	{
		error: new ImageGenerationConfigError({
			model: "m",
			field: "frameCount",
			reason: "requires-option",
			related: "outputFormat",
			detail: "frameCount applies to animated GIF output only",
			hint: "Set outputFormat.",
		}),
		name: "ImageGenerationConfigError",
		code: "invalid-option",
		retryable: false,
		guards: [isImageGenerationConfigError],
	},
	{
		error: new ImageGenerationApiError({ ...apiInit, retryable: true }),
		name: "ImageGenerationApiError",
		code: "api-error",
		retryable: true,
		guards: [isImageGenerationApiError],
	},
	{
		error: new ImageGenerationQuotaError(apiInit),
		name: "ImageGenerationQuotaError",
		code: "quota-exceeded",
		retryable: false,
		guards: [isImageGenerationApiError, isImageGenerationQuotaError],
	},
	{
		error: new ImageGenerationRateLimitError(apiInit),
		name: "ImageGenerationRateLimitError",
		code: "rate-limited",
		retryable: true,
		guards: [isImageGenerationApiError, isImageGenerationRateLimitError],
	},
	{
		error: new ImageGenerationServerError(apiInit),
		name: "ImageGenerationServerError",
		code: "server-error",
		retryable: true,
		guards: [isImageGenerationApiError, isImageGenerationServerError],
	},
	{
		error: new ImageGenerationUserError(apiInit),
		name: "ImageGenerationUserError",
		code: "user-error",
		retryable: false,
		guards: [isImageGenerationApiError, isImageGenerationUserError],
	},
	{
		error: new ImageModerationBlockedError({ ...apiInit, moderationStage: "input", categories: ["harassment"] }),
		name: "ImageModerationBlockedError",
		code: "moderation-blocked",
		retryable: false,
		guards: [isImageGenerationApiError, isImageGenerationUserError, isImageModerationBlockedError],
	},
	{
		error: new ImageGenerationTimeoutError({ timeoutMs: 100, elapsedMs: 120 }),
		name: "ImageGenerationTimeoutError",
		code: "timeout",
		retryable: true,
		guards: [isImageGenerationTimeoutError],
	},
];

const FOREIGN_SHAPES = [
	["ImageGenerationError", "any-future-code"],
	["ImageGenerationConfigError", "invalid-option"],
	["ImageGenerationApiError", "api-error"],
	["ImageGenerationQuotaError", "quota-exceeded"],
	["ImageGenerationRateLimitError", "rate-limited"],
	["ImageGenerationServerError", "server-error"],
	["ImageGenerationUserError", "user-error"],
	["ImageModerationBlockedError", "moderation-blocked"],
	["ImageGenerationTimeoutError", "timeout"],
] as const;

function chainLength(value: unknown): number {
	let length = 0;
	for (let current = value; current !== undefined && current !== null; length++) {
		current = (current as { cause?: unknown }).cause;
	}
	return length;
}

const ALL_GUARDS = [
	isImageGenerationConfigError,
	isImageGenerationApiError,
	isImageGenerationQuotaError,
	isImageGenerationRateLimitError,
	isImageGenerationServerError,
	isImageGenerationUserError,
	isImageModerationBlockedError,
	isImageGenerationTimeoutError,
];

describe("image generation errors (#4332)", () => {
	it.each(samples)("$name has a literal name, a stable code and explicit retryability (#4332)", (sample) => {
		assert(sample.error instanceof ImageGenerationError);
		assert(sample.error instanceof Error);
		assert.equal(sample.error.name, sample.name);
		assert.equal(sample.error.code, sample.code);
		assert.equal(sample.error.retryable, sample.retryable);
		assert.equal(isRetryableImageGenerationError(sample.error), sample.retryable);
		assert(isImageGenerationError(sample.error));
		assert.ok(sample.error.hint);
		assert(sample.error.message.length > 0);
	});

	it.each(samples)("matches exactly its own guards: $name (#4332)", (sample) => {
		const matching = ALL_GUARDS.filter((guard) => guard(sample.error));
		assert.deepEqual(matching, sample.guards);
	});

	it.each(samples)("$name survives a JSON round trip with its class and fields (#4332)", (sample) => {
		const data = JSON.parse(JSON.stringify(sample.error)) as ImageGenerationErrorData;

		const revived = imageGenerationErrorFromData(data);

		assert.equal(revived.constructor, sample.error.constructor);
		assert.equal(revived.name, sample.name);
		assert.equal(revived.code, sample.code);
		assert.equal(revived.retryable, sample.retryable);
		assert.equal(revived.message, sample.error.message);
		assert.equal(revived.hint, sample.error.hint);
		assert.deepEqual(revived.toData(), sample.error.toData());
		assert.deepEqual(
			ALL_GUARDS.filter((guard) => guard(revived)),
			sample.guards,
		);
	});

	it.each([
		new ImageGenerationQuotaError({ ...apiInit, retryable: true }),
		new ImageGenerationRateLimitError({ ...apiInit, retryable: false }),
		new ImageGenerationServerError({ ...apiInit, detail: "HTTP 503", retryable: false }),
		new ImageGenerationUserError({ ...apiInit, retryable: true }),
		new ImageModerationBlockedError({ ...apiInit, retryable: true }),
	])("keeps an explicit retryable override on $name across a JSON round trip (#4332)", (error) => {
		const revived = imageGenerationErrorFromData(JSON.parse(JSON.stringify(error)) as ImageGenerationErrorData);

		assert.equal(revived.constructor, error.constructor);
		assert.equal(revived.retryable, error.retryable);
		assert.equal(isRetryableImageGenerationError(revived), error.retryable);
		assert.deepEqual(revived.toData(), error.toData());
	});

	it("keeps the api fields on the typed error (#4332)", () => {
		const error = new ImageGenerationApiError(apiInit);

		assert.equal(error.status, 400);
		assert.equal(error.apiCode, "some_code");
		assert.equal(error.apiType, "some_type");
		assert.equal(error.requestId, "req_1");
		assert.equal(error.detail, "provider said no");
		assert.equal(error.retryable, false);
	});

	it("serializes only safe, JSON-compatible fields (#4332)", () => {
		const error = new ImageModerationBlockedError({
			...apiInit,
			moderationStage: "output",
			categories: ["violence"],
			cause: new Error("socket hung up"),
		});

		const data = error.toData();

		assert.deepEqual(data.fields, {
			detail: "provider said no",
			status: 400,
			apiCode: "some_code",
			apiType: "some_type",
			requestId: "req_1",
			moderationStage: "output",
			categories: ["violence"],
		});
		assert.deepEqual(data.cause, { name: "Error", message: "[foreign error message omitted]" });
		assert.equal(JSON.stringify(data).includes("stack"), false);
	});

	it("checks the value itself in guards and searches wrappers with findImageGenerationError (#4332)", () => {
		const inner = new ImageGenerationQuotaError(apiInit);
		const wrapped = new Error("outer", { cause: new Error("middle", { cause: inner }) });

		assert.equal(isImageGenerationQuotaError(wrapped), false);
		assert.equal(isImageGenerationApiError(wrapped), false);
		assert.equal(isImageGenerationError(wrapped), false);
		assert.equal(findImageGenerationError(wrapped), inner);
		assert.equal(findImageGenerationError(wrapped, isImageGenerationQuotaError), inner);
		assert.equal(findImageGenerationError(wrapped, isImageGenerationRateLimitError), undefined);
		assert.equal(isRetryableImageGenerationError(wrapped), false);
		assert.equal(findImageGenerationError(new Error("plain")), undefined);
		assert.equal(findImageGenerationError("not an error"), undefined);
		assert.equal(isImageGenerationError(undefined), false);
		assert.equal(isImageGenerationError(null), false);
		assert.equal(isRetryableImageGenerationError(new Error("plain")), false);
	});

	it("stops a cause-chain search at a null or missing link (#4332)", () => {
		assert.equal(findImageGenerationError(null), undefined);
		assert.equal(findImageGenerationError(new Error("outer", { cause: null })), undefined);
		assert.equal(findImageGenerationError({ cause: null }, isImageGenerationError), undefined);
		assert.equal(isRetryableImageGenerationError(new Error("outer", { cause: null })), false);
	});

	it("rehydrates a cause that lacks the code, retryability or fields of the family as a plain error (#4332)", () => {
		const complete = { name: "ImageGenerationQuotaError", code: "quota-exceeded", retryable: false, fields: {} };
		const partials = [
			{ ...complete, code: undefined },
			{ ...complete, retryable: undefined },
			{ ...complete, fields: undefined },
			{ ...complete, fields: null },
		];

		for (const partial of partials) {
			const revived = imageGenerationErrorFromData({
				...complete,
				message: "outer",
				cause: { ...partial, message: "inner" } as unknown as ImageGenerationErrorData,
			});
			assert(revived.cause instanceof Error, JSON.stringify(partial));
			assert.equal(revived.cause instanceof ImageGenerationError, false, JSON.stringify(partial));
			assert.equal(revived.cause.name, "ImageGenerationQuotaError");
			assert.equal(revived.cause.message, "[foreign error message omitted]");
		}
	});

	it("bounds the cause-chain walk on a cycle (#4332)", () => {
		const loop: Error & { cause?: unknown } = new Error("loop");
		loop.cause = loop;

		assert.equal(isImageGenerationError(loop), false);
		assert.equal(findImageGenerationError(loop), undefined);
	});

	it("recognizes a structurally matching error from another realm (#4332)", () => {
		const foreign = { name: "ImageGenerationRateLimitError", code: "rate-limited", retryable: true };

		assert(isImageGenerationRateLimitError(foreign));
		assert(isImageGenerationApiError(foreign));
		assert(isImageGenerationError(foreign));
		assert.equal(isImageGenerationQuotaError(foreign), false);
		assert.equal(isRetryableImageGenerationError(foreign), true);
		assert.equal(isImageGenerationError({ name: "ImageGenerationRateLimitError" }), false);
		assert.equal(isImageGenerationError({ name: "Other", code: "x" }), false);
	});

	it("rehydrates an unknown name into the family base keeping name and code (#4332)", () => {
		const revived = imageGenerationErrorFromData({
			name: "ImageGenerationFutureError",
			code: "future-code",
			message: "from a newer worker",
			hint: "upgrade",
			retryable: true,
			fields: {},
		});

		assert.equal(revived.constructor, ImageGenerationError);
		assert.equal(revived.name, "ImageGenerationFutureError");
		assert.equal(revived.code, "future-code");
		assert.equal(revived.message, "from a newer worker");
		assert.equal(revived.hint, "upgrade");
		assert.equal(revived.retryable, true);
	});

	it("keeps a typed cause chain across a JSON round trip (#4332)", () => {
		const server = new ImageGenerationServerError({
			detail: "HTTP 503",
			status: 503,
			cause: new RangeError("socket closed"),
		});
		const rateLimited = new ImageGenerationRateLimitError({ detail: "HTTP 429", status: 429, cause: server });
		const outer = new ImageGenerationApiError({ detail: "HTTP 400", status: 400, cause: rateLimited });

		const data = JSON.parse(JSON.stringify(outer)) as ImageGenerationErrorData;
		const revived = imageGenerationErrorFromData(data);

		assert.equal(data.cause?.name, "ImageGenerationRateLimitError");
		assert(revived.cause instanceof ImageGenerationRateLimitError);
		assert.equal(revived.cause.code, "rate-limited");
		assert.equal(revived.cause.status, 429);
		assert(isImageGenerationRateLimitError(revived.cause));
		assert(revived.cause.cause instanceof ImageGenerationServerError);
		assert.equal(revived.cause.cause.status, 503);
		assert(isImageGenerationServerError(revived.cause.cause));
		assert.equal(revived.cause.cause.cause instanceof ImageGenerationError, false);
		assert(revived.cause.cause.cause instanceof Error);
		assert.equal(revived.cause.cause.cause.name, "RangeError");
		assert.equal(revived.cause.cause.cause.message, "[foreign error message omitted]");
		assert.equal(chainLength(revived), 4);
		assert.deepEqual(revived.toData(), outer.toData());
		assert.equal(findImageGenerationError(revived, isImageGenerationServerError), revived.cause.cause);
		assert.equal(isRetryableImageGenerationError(revived), false);
		assert.equal(isRetryableImageGenerationError(revived.cause), true);
	});

	it("round trips foreign wrappers without exposing their messages (#4332)", () => {
		const sentinel = "PRIVATE_PROMPT_SENTINEL";
		const socket = Object.assign(new Error(sentinel), { code: "ECONNRESET" });
		const wrapper = new TypeError(sentinel, { cause: socket });
		const error = new ImageGenerationServerError({ detail: "HTTP 503", status: 503, cause: wrapper });

		const data = error.toData();
		const revived = imageGenerationErrorFromData(JSON.parse(JSON.stringify(data)));

		assert.deepEqual(data.cause, {
			name: "TypeError",
			message: "[foreign error message omitted]",
			cause: { name: "Error", code: "ECONNRESET", message: "[foreign error message omitted]" },
		});
		assert(revived.cause instanceof Error);
		assert(revived.cause.cause instanceof Error);
		assert.equal((revived.cause.cause as NodeJS.ErrnoException).code, "ECONNRESET");
		assert.equal(JSON.stringify(revived.toData()), JSON.stringify(data));
		assert.equal(JSON.stringify(data).includes(sentinel), false);
		assert.equal(String(error.cause).includes(sentinel), false);
	});

	it("retains typed causes through foreign wrappers while rejecting arbitrary foreign codes (#4332)", () => {
		const inner = new ImageGenerationTimeoutError({ timeoutMs: 50, elapsedMs: 60 });
		const wrapper = Object.assign(new Error("private", { cause: inner }), { code: "PRIVATE_PROMPT" });
		const outer = new ImageGenerationServerError({ detail: "HTTP 503", cause: wrapper });
		const data = outer.toData();
		const revived = imageGenerationErrorFromData(JSON.parse(JSON.stringify(data)));

		assert(outer.cause instanceof Error);
		assert.equal(outer.cause.cause, inner);
		assert.equal(data.cause?.code, undefined);
		assert(revived.cause instanceof Error);
		assert(revived.cause.cause instanceof ImageGenerationTimeoutError);
		assert.equal(revived.cause.cause.timeoutMs, 50);
		assert.equal(revived.cause.cause.elapsedMs, 60);
		assert.equal(JSON.stringify(data).includes("PRIVATE_PROMPT"), false);
	});

	it("bounds foreign cycles and rehydrated foreign chains to eight links (#4332)", () => {
		const loop: Error & { cause?: unknown } = new Error("private");
		loop.cause = loop;
		const outer = new ImageGenerationServerError({ detail: "HTTP 503", cause: loop });
		const data = outer.toData();
		assert.equal(chainLength(outer), 8);
		assert.equal(chainLength(data), 8);
		assert.equal(chainLength(imageGenerationErrorFromData(data)), 8);

		let tail = data.cause;
		assert(tail);
		while (tail.cause) tail = tail.cause;
		tail.cause = { name: "Error", message: "private", cause: { name: "Error", message: "private" } };
		assert.equal(chainLength(imageGenerationErrorFromData(data)), 8);

		let foreign = new Error("private");
		for (let link = 1; link < 12; link++) foreign = new Error("private", { cause: foreign });
		outer.cause = foreign;
		assert.equal(chainLength(outer.toData()), 8);

		const cyclic = { name: "Error", message: "private", cause: data.cause };
		cyclic.cause = cyclic;
		data.cause = cyclic;
		assert.equal(chainLength(imageGenerationErrorFromData(data)), 8);
	});

	it("round trips known foreign system codes and omits unrecognized codes (#4332)", () => {
		const codes = (
			"EACCES EADDRINUSE EADDRNOTAVAIL EAFNOSUPPORT EAGAIN EALREADY EBADF EBUSY ECANCELED " +
			"ECONNABORTED ECONNREFUSED ECONNRESET EDESTADDRREQ EEXIST EFAULT EHOSTUNREACH EINTR " +
			"EINVAL EIO EISDIR EMFILE EMSGSIZE ENETDOWN ENETRESET ENETUNREACH ENFILE ENOENT ENOMEM " +
			"ENOSPC ENOTCONN ENOTDIR ENOTFOUND ENOTSOCK ENOTSUP EPIPE EPERM EPROTO EPROTONOSUPPORT " +
			"ETIMEDOUT EAI_AGAIN EAI_FAIL EAI_NONAME"
		).split(" ");
		for (const code of codes) {
			const error = new ImageGenerationServerError({
				detail: "HTTP 503",
				cause: Object.assign(new Error(), { code }),
			});
			const data = error.toData();
			const revived = imageGenerationErrorFromData(JSON.parse(JSON.stringify(data)));
			assert.equal(data.cause?.code, code);
			assert(revived.cause instanceof Error);
			assert.equal((revived.cause as NodeJS.ErrnoException).code, code);
		}
		for (const code of ["E_PRIVATE", 42, null, ""]) {
			const error = new ImageGenerationServerError({
				detail: "HTTP 503",
				cause: Object.assign(new Error(), { code }),
			});
			assert.equal(error.toData().cause?.code, undefined);
			assert(error.cause instanceof Error);
			assert.equal(Object.hasOwn(error.cause, "code"), false);
		}
	});

	it("sanitizes foreign names and ignores non-error causes (#4332)", () => {
		for (const [name, expected] of [
			["TypeError", "TypeError"],
			["A".repeat(80), "A".repeat(80)],
			["", "Error"],
			["bad name", "Error"],
			["A".repeat(81), "Error"],
		]) {
			const foreign = new Error("private");
			foreign.name = name;
			const outer = new ImageGenerationServerError({ detail: "HTTP 503", cause: foreign });
			assert.equal(outer.toData().cause?.name, expected);
			assert.equal((imageGenerationErrorFromData(outer.toData()).cause as Error).name, expected);
		}
		const malformed = new ImageGenerationServerError({
			detail: "HTTP 503",
			cause: Object.assign(new Error("private"), { name: true }),
		});
		assert.equal(malformed.toData().cause?.name, "Error");
		assert.equal(
			new ImageGenerationServerError({ detail: "HTTP 503", cause: { message: "private" } }).toData().cause,
			undefined,
		);
	});

	it("keeps at most eight links of a cause chain when serializing and rehydrating (#4332)", () => {
		let error: ImageGenerationError = new ImageGenerationServerError({ detail: "HTTP 500", status: 500 });
		for (let link = 1; link < 10; link++) {
			error = new ImageGenerationServerError({ detail: `HTTP 50${link % 10}`, status: 500 + link, cause: error });
		}
		const deep = (links: number): ImageGenerationErrorData => {
			const data = error.toData();
			let tail = data;
			for (let link = 1; link < links; link++) {
				tail.cause = { ...tail, cause: undefined };
				tail = tail.cause as ImageGenerationErrorData;
			}
			return data;
		};

		const data = error.toData();

		assert.equal(chainLength(error), 10);
		assert.equal(chainLength(data), 8);
		assert.equal(chainLength(imageGenerationErrorFromData(data)), 8);
		assert.equal(chainLength(deep(12)), 12);
		assert.equal(chainLength(imageGenerationErrorFromData(deep(12))), 8);
		assert.equal(chainLength(imageGenerationErrorFromData(deep(8))), 8);
	});

	it("rehydrates the cause of a config error (#4332)", () => {
		const revived = imageGenerationErrorFromData(
			new ImageGenerationConfigError({
				model: "m",
				field: "frameCount",
				reason: "out-of-range",
				detail: "d",
				hint: "h",
				cause: new ImageGenerationTimeoutError({ timeoutMs: 1, elapsedMs: 2 }),
			}).toData(),
		);

		assert(isImageGenerationConfigError(revived));
		assert(revived.cause instanceof ImageGenerationTimeoutError);
		assert.equal(revived.cause.elapsedMs, 2);
	});

	it("restores the cause of a rehydrated error (#4332)", () => {
		const revived = imageGenerationErrorFromData(
			new ImageGenerationTimeoutError({ timeoutMs: 5, elapsedMs: 6, cause: new RangeError("slow") }).toData(),
		);

		assert(revived.cause instanceof Error);
		assert.equal(revived.cause.name, "RangeError");
		assert.equal(revived.cause.message, "[foreign error message omitted]");
	});

	it("ignores unusable moderation fields when rehydrating (#4332)", () => {
		const revived = imageGenerationErrorFromData({
			name: "ImageModerationBlockedError",
			code: "moderation-blocked",
			message: "blocked",
			retryable: false,
			fields: { moderationStage: "sideways", categories: "violence" },
		});

		assert(isImageModerationBlockedError(revived));
		assert.deepEqual(revived.categories, []);
		assert.equal(revived.moderationStage, undefined);
	});

	it("reports typed failures on image results and leaves aborts untyped (#4332)", () => {
		const model = {
			api: "openai-images",
			provider: "openai-images",
			id: "gpt-image-2.6-flare",
		} as ImageModel<"openai-images">;
		const typed = new ImageGenerationQuotaError(apiInit);

		const failed = imageErrorResult(model, typed);
		const aborted = imageErrorResult(model, typed, true);
		const plain = imageErrorResult(model, new Error("plain"));

		assert.equal(failed.stopReason, "error");
		assert.deepEqual(failed.error, typed.toData());
		assert.equal(aborted.stopReason, "aborted");
		assert.equal(aborted.error, undefined);
		assert.equal(plain.error, undefined);
	});

	it.each(FOREIGN_SHAPES)(
		"matches a structural %s with code %s from another realm with exactly the right guards (#4332)",
		(name, code) => {
			const foreign = { name, code };
			const sample = samples.find((candidate) => candidate.name === name);

			assert.equal(isImageGenerationError(foreign), true);
			assert.deepEqual(
				ALL_GUARDS.filter((guard) => guard(foreign)),
				sample?.guards ?? [],
			);
		},
	);

	it.each(FOREIGN_SHAPES.filter(([name]) => name !== "ImageGenerationError"))(
		"rejects a structural %s whose code is not %s (#4332)",
		(name, code) => {
			const sibling = FOREIGN_SHAPES.find(([other]) => other !== name && other !== "ImageGenerationError")?.[1];

			for (const wrong of ["not-a-real-code", sibling, code.toUpperCase(), ""]) {
				const foreign = { name, code: wrong, retryable: true };
				assert.equal(isImageGenerationError(foreign), false, String(wrong));
				assert.deepEqual(
					ALL_GUARDS.filter((guard) => guard(foreign)),
					[],
				);
				assert.equal(isRetryableImageGenerationError(new Error("outer", { cause: foreign })), false);
			}
		},
	);

	it("rejects values that only look like image-generation errors (#4332)", () => {
		for (const value of [
			{ name: "ImageGenerationQuotaError", code: 5 },
			{ name: "ImageGenerationError", code: 5 },
			{ name: "ImageGenerationError" },
			{ name: 5, code: "quota-exceeded" },
			{ name: "ImageGenerationQuotaError" },
			{ code: "quota-exceeded" },
			"ImageGenerationQuotaError",
			42,
			true,
			null,
			undefined,
		]) {
			for (const guard of [isImageGenerationError, ...ALL_GUARDS]) assert.equal(guard(value), false);
		}
	});

	it("walks at most eight links of a cause chain (#4332)", () => {
		const target = new ImageGenerationQuotaError(apiInit);
		const wrap = (depth: number) => {
			let current: Error = target;
			for (let index = 0; index < depth; index++) current = new Error(`wrapper ${index}`, { cause: current });
			return current;
		};

		assert.equal(findImageGenerationError(wrap(7)), target);
		assert.equal(findImageGenerationError(wrap(8)), undefined);
		assert.equal(findImageGenerationError(wrap(7), isImageGenerationQuotaError), target);
		assert.equal(findImageGenerationError(wrap(8), isImageGenerationQuotaError), undefined);
		assert.equal(isRetryableImageGenerationError(wrap(7)), false);
		assert.equal(isImageGenerationQuotaError(wrap(1)), false);
	});

	it("reads retryability from the nearest valid image-generation error below a wrapper (#4332)", () => {
		const retryable = new Error("outer", { cause: new ImageGenerationRateLimitError(apiInit) });
		const lookalike = (code: string) =>
			new Error("outer", { cause: { name: "ImageGenerationServerError", code, retryable: true } });

		assert.equal(isRetryableImageGenerationError(retryable), true);
		assert.equal(isRetryableImageGenerationError(lookalike("server-error")), true);
		assert.equal(isRetryableImageGenerationError(lookalike("x")), false);
		assert.equal(
			isRetryableImageGenerationError(new Error("outer", { cause: { name: "Other", retryable: true } })),
			false,
		);
	});

	it("serializes a plain family error with no fields and a redacted cause (#4332)", () => {
		const long = "x".repeat(600);
		const base = new ImageGenerationError({
			name: "ImageGenerationFutureError",
			code: "future",
			message: "m",
			cause: new Error(long),
		});

		const data = base.toData();

		assert.deepEqual(data.fields, {});
		assert.equal(data.hint, undefined);
		assert.equal(data.cause?.message, "[foreign error message omitted]");
		assert.equal(new ImageGenerationError({ name: "N", code: "c", message: "m" }).toData().cause, undefined);
		assert.equal("hint" in new ImageGenerationError({ name: "N", code: "c", message: "m" }).toData(), false);
	});

	it("defaults api errors to non-retryable and moderation categories to none (#4332)", () => {
		const api = new ImageGenerationApiError({ detail: "d" });
		const blocked = new ImageModerationBlockedError({ detail: "d" });

		assert.equal(api.retryable, false);
		assert.equal(api.code, "api-error");
		assert.equal(api.name, "ImageGenerationApiError");
		assert.deepEqual(blocked.categories, []);
		assert.equal(blocked.moderationStage, undefined);
		assert.equal(api.status, undefined);
	});

	it("renders the messages of api and timeout errors from their fields (#4332)", () => {
		assert.equal(
			new ImageGenerationApiError({ detail: "provider said no", status: 401 }).message,
			"Image generation request failed (api-error): provider said no",
		);
		assert.equal(
			new ImageGenerationTimeoutError({ timeoutMs: 100, elapsedMs: 120 }).message,
			"Image generation timed out: request after 120ms of 100ms (timeout). Raise timeoutMs or lower the image size, count or quality.",
		);
	});

	it("falls back to safe defaults when rehydrating incomplete or mistyped data (#4332)", () => {
		const config = imageGenerationErrorFromData({
			name: "ImageGenerationConfigError",
			code: "invalid-option",
			message: "m",
			retryable: false,
			fields: { model: 5, field: undefined, reason: 7, detail: false },
		});
		const timeout = imageGenerationErrorFromData({
			name: "ImageGenerationTimeoutError",
			code: "timeout",
			message: "m",
			retryable: true,
			fields: { timeoutMs: "100", elapsedMs: undefined },
		});
		const api = imageGenerationErrorFromData({
			name: "ImageGenerationApiError",
			code: "api-error",
			message: "original message",
			retryable: false,
			fields: { detail: 7, status: "400", apiCode: 1, apiType: 2, requestId: 3 },
		});

		assert(isImageGenerationConfigError(config));
		assert.deepEqual([config.model, config.field, config.reason, config.hint], ["", "", "out-of-range", ""]);
		assert.equal(config.detail, "m");
		assert(isImageGenerationTimeoutError(timeout));
		assert.deepEqual([timeout.timeoutMs, timeout.elapsedMs], [0, 0]);
		assert(isImageGenerationApiError(api));
		assert.deepEqual(
			[api.status, api.apiCode, api.apiType, api.requestId],
			[undefined, undefined, undefined, undefined],
		);
		assert.equal(api.detail, "original message");
	});

	it("keeps only string categories when rehydrating a moderation error (#4332)", () => {
		const build = (fields: ImageGenerationErrorData["fields"]) =>
			imageGenerationErrorFromData({
				name: "ImageModerationBlockedError",
				code: "moderation-blocked",
				message: "blocked",
				retryable: false,
				fields,
			});

		const mixed = build(JSON.parse('{"categories":["harassment",7,"violence",null]}'));
		const missing = build({});

		assert(isImageModerationBlockedError(mixed));
		assert.deepEqual(mixed.categories, ["harassment", "violence"]);
		assert(isImageModerationBlockedError(missing));
		assert.deepEqual(missing.categories, []);
	});
});
