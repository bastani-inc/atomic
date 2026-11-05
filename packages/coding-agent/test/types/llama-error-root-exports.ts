import type {
	isRetryableLlamaServerError,
	LlamaServerErrorCode,
	LlamaServerRequestError,
	LlamaServerUnreachableError,
} from "../../src/index.ts";

type Equal<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;
type Assert<Condition extends true> = Condition;

export type LlamaServerErrorCodeRootExport = Assert<
	Equal<LlamaServerErrorCode, "server-unreachable" | "request-rejected">
>;
export type RetryableLlamaServerErrorRootExport = Assert<
	Equal<typeof isRetryableLlamaServerError, (error: unknown) => boolean>
>;
export type UnreachableCodeRootExport = Assert<Equal<LlamaServerUnreachableError["code"], "server-unreachable">>;
export type RequestRejectedCodeRootExport = Assert<Equal<LlamaServerRequestError["code"], "request-rejected">>;
