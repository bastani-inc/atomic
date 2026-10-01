import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AnyModel,
	ClassifierContext,
	ImageContent,
	ImagesContext,
	ModelType,
	ModelTypeMap,
	TextContent,
	Usage,
} from "@bastani/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	type CodemodeResult,
	CodemodeSandbox,
	type CodemodeTool,
	loadQuickJSWasm,
	parseCodemodeSource,
	renderToolSample,
	toCodemodeIdentifier,
} from "@earendil-works/pi-codemode";
import { getCodemodeWorkerUrl, getQuickJSWasmPath } from "../../config.js";
import type { ExtensionToolContext } from "../../core/extensions/context-types.ts";
import type { ToolNamespace } from "../../core/extensions/tool-types.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
import { combineUsage } from "../../core/usage-totals.ts";
import { Bm25Ranker, createToolSearchDocument, DEFAULT_TOOL_SEARCH_LIMIT } from "../tool-search/tool.js";
import {
	CODEMODE_DOCS_PATH,
	CODEMODE_STORE_ENTRY_TYPE,
	type CodemodeNestedCall,
	type CodemodeToolDetails,
	type CodemodeToolInput,
	type CodemodeToolOptions,
	getCodemodeCallableTools,
	toCodemodeDeclaration,
} from "./tool.js";

export function readCodemodeStore(branch: readonly SessionEntry[]): Record<string, unknown> {
	const store = new Map<string, unknown>();
	for (const entry of branch) {
		if (
			entry.type !== "custom" ||
			entry.customType !== CODEMODE_STORE_ENTRY_TYPE ||
			typeof entry.data !== "object" ||
			entry.data === null
		)
			continue;
		const data = entry.data as { set?: Record<string, unknown>; delete?: string[] };
		if (
			!data.set ||
			typeof data.set !== "object" ||
			!Array.isArray(data.delete) ||
			!data.delete.every((key) => typeof key === "string")
		)
			continue;
		for (const key of data.delete) store.delete(key);
		for (const [key, value] of Object.entries(data.set)) store.set(key, value);
	}
	return Object.fromEntries(store);
}
function textOf(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}
/** Explicit public catalog fields. Provider configuration and credential-bearing URLs never cross into the VM. */
export function toCodemodeModelInfo(model: AnyModel): Record<string, unknown> {
	return {
		type: model.type,
		provider: model.provider,
		id: model.id,
		name: model.name,
		api: model.api,
		input: model.input,
		...("reasoning" in model ? { reasoning: model.reasoning } : {}),
		...("contextWindow" in model ? { contextWindow: model.contextWindow } : {}),
		...("maxTokens" in model ? { maxTokens: model.maxTokens } : {}),
		cost: model.cost,
	};
}
const MODEL_TYPES = ["chat", "image", "classifier"] as const;
function modelType(value: unknown): ModelType {
	if (value === "chat" || value === "image" || value === "classifier") return value;
	throw new Error('Model type must be "chat", "image", or "classifier"');
}
function withArticle(word: string): string {
	return `${/^[aeiou]/.test(word) ? "an" : "a"} ${word}`;
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function describeValue(value: unknown): string {
	if (value === undefined || value === null) return String(value);
	if (Array.isArray(value)) return value.length === 0 ? "an empty array" : "an array";
	if (typeof value === "object") {
		const keys = Object.keys(value);
		if (keys.length === 0) return "{}";
		return `{ ${keys.slice(0, 6).join(", ")}${keys.length > 6 ? ", ..." : ""} }`;
	}
	return typeof value === "string" ? "a string" : `a ${typeof value}`;
}
const CLASSIFIER_CONTEXT_SHAPE =
	'{ state: { ... }, questions: { <id>: { type: "choice", instructions, criteria: { <label>: <meaning> } } | { type: "score", instructions, criteria: [<lowest level>, ..., <highest level>] } | { type: "bool", instructions, criteria: { true: <meaning>, false: <meaning> } } } }';
function checkClassifierContext(context: unknown): ClassifierContext {
	const fail = (problem: string) =>
		new Error(
			`models.classify() ${problem}. Expected context: ${CLASSIFIER_CONTEXT_SHAPE}. See "Classify" in ${CODEMODE_DOCS_PATH}.`,
		);
	if (!isRecord(context)) throw fail(`expects a context object as its second argument, got ${describeValue(context)}`);
	if (!isRecord(context.state)) throw fail(`context.state must be an object, got ${describeValue(context.state)}`);
	const { questions } = context;
	if (!isRecord(questions) || Object.keys(questions).length === 0)
		throw fail(`context.questions must map question IDs to questions, got ${describeValue(questions)}`);
	const isStrings = (values: unknown[]) => values.length > 0 && values.every((value) => typeof value === "string");
	for (const [questionId, question] of Object.entries(questions)) {
		const at = `context.questions.${questionId}`;
		if (!isRecord(question)) throw fail(`${at} must be a question object, got ${describeValue(question)}`);
		if (typeof question.instructions !== "string") throw fail(`${at}.instructions must be a string`);
		const { criteria } = question;
		if (question.type === "choice") {
			if (!isRecord(criteria) || !isStrings(Object.values(criteria)))
				throw fail(`${at} is a "choice" question, so criteria must map each label to its meaning`);
		} else if (question.type === "score") {
			if (!Array.isArray(criteria) || !isStrings(criteria))
				throw fail(`${at} is a "score" question, so criteria must list the levels as strings, lowest first`);
		} else if (question.type === "bool") {
			if (!isRecord(criteria) || typeof criteria.true !== "string" || typeof criteria.false !== "string")
				throw fail(`${at} is a "bool" question, so criteria must be { true: string, false: string }`);
		} else {
			throw fail(`${at}.type must be "choice", "score", or "bool", got ${JSON.stringify(question.type)}`);
		}
	}
	return context as unknown as ClassifierContext;
}
function checkImagesContext(context: unknown): ImagesContext {
	const fail = (problem: string) =>
		new Error(
			`models.generateImages() ${problem}. Expected context: { input: [{ type: "text", text: <prompt> }, ...optional { type: "image", data: <base64>, mimeType } references] }. See "Generate images" in ${CODEMODE_DOCS_PATH}.`,
		);
	if (!isRecord(context)) throw fail(`expects a context object as its second argument, got ${describeValue(context)}`);
	const { input } = context;
	if (!Array.isArray(input) || input.length === 0)
		throw fail(`context.input must be a non-empty array of blocks, got ${describeValue(input)}`);
	input.forEach((block: unknown, index) => {
		if (isRecord(block) && block.type === "text" && typeof block.text === "string") return;
		if (
			isRecord(block) &&
			block.type === "image" &&
			typeof block.data === "string" &&
			typeof block.mimeType === "string"
		)
			return;
		throw fail(`context.input[${index}] must be a text or image block, got ${describeValue(block)}`);
	});
	return context as unknown as ImagesContext;
}
function provider(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "string") return value;
	throw new Error("provider must be a string");
}
function preview(args: unknown): string {
	try {
		return (JSON.stringify(args) ?? "").slice(0, 200);
	} catch {
		return "";
	}
}
interface ModelCallResult {
	stopReason: "stop" | "error" | "aborted";
	errorMessage?: string;
	usage?: Usage;
}
function createLimiter(limit: number) {
	let active = 0;
	const waiting: (() => void)[] = [];
	return async <T>(run: () => Promise<T>): Promise<T> => {
		if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
		active++;
		try {
			return await run();
		} finally {
			active--;
			waiting.shift()?.();
		}
	};
}
function discoveryGlobals(
	tools: readonly AgentTool[],
	samples: ReadonlyMap<string, string>,
	options: CodemodeToolOptions,
): CodemodeTool[] {
	const entry = (name: string) => ({ name: toCodemodeIdentifier(name), description: samples.get(name) ?? "" });
	return [
		{
			name: "searchTools",
			spread: true,
			execute: (args) => {
				const [query, config] = args as [unknown, { limit?: unknown; namespace?: unknown } | undefined];
				if (typeof query !== "string") throw new Error("searchTools() expects a query string");
				const limit = config?.limit ?? DEFAULT_TOOL_SEARCH_LIMIT;
				if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0)
					throw new Error("searchTools() limit must be a positive integer");
				if (config?.namespace !== undefined && typeof config.namespace !== "string")
					throw new Error("searchTools() namespace must be a string");
				const docs = tools.flatMap((tool) => {
					const namespace = options.getToolNamespace?.(tool.name);
					return config?.namespace && namespace?.name !== config.namespace
						? []
						: [createToolSearchDocument(tool, namespace)];
				});
				return new Bm25Ranker().rank(query, docs, limit).map((match) => entry(match.name));
			},
		},
		{
			name: "describeTool",
			spread: true,
			execute: (args) => {
				const [name] = args as unknown[];
				if (typeof name !== "string") throw new Error("describeTool() expects a tool name");
				const tool = tools.find((tool) => tool.name === name || toCodemodeIdentifier(tool.name) === name);
				return tool ? samples.get(tool.name) : undefined;
			},
		},
		{
			name: "describeNamespace",
			spread: true,
			execute: (args) => {
				const [name] = args as unknown[];
				if (typeof name !== "string") throw new Error("describeNamespace() expects a namespace name");
				let namespace: ToolNamespace | undefined;
				const names: string[] = [];
				for (const tool of tools) {
					const toolNamespace = options.getToolNamespace?.(tool.name);
					if (toolNamespace?.name !== name) continue;
					namespace ??= toolNamespace;
					names.push(toCodemodeIdentifier(tool.name));
				}
				if (!namespace) return undefined;
				return {
					name,
					...(namespace.description ? { description: namespace.description } : {}),
					...(namespace.instructions ? { instructions: namespace.instructions } : {}),
					tools: names,
				};
			},
		},
	];
}
function modelGlobals(
	ctx: ExtensionToolContext,
	id: string,
	calls: CodemodeNestedCall[],
	publish: () => void,
	addUsage: (usage: Usage) => void,
	addGeneratedImages: (count: number) => void,
): CodemodeTool[] {
	const models = ctx.modelRegistry;
	const limit = createLimiter(4);
	let count = 0;
	const runModelCall = async <TType extends "classifier" | "image", TContext, TResult extends ModelCallResult>(
		name: string,
		type: TType,
		[ref, context]: unknown[],
		checkContext: (context: unknown) => TContext,
		run: (model: ModelTypeMap[TType], context: TContext) => Promise<TResult>,
	): Promise<TResult> => {
		const listHint = `List the ${type} models you can use with models.getAvailableOfType("${type}").`;
		if (!isRecord(ref) || typeof ref.provider !== "string" || typeof ref.id !== "string") {
			const undefinedHint =
				ref === undefined || ref === null
					? " models.getModelOfType() returns undefined for an unknown provider or id."
					: "";
			throw new Error(
				`${name}() expects ${withArticle(type)} model as its first argument, got ${describeValue(ref)}.${undefinedHint} ${listHint}`,
			);
		}
		const { provider: providerId, id: modelId } = ref;
		const model = models.getModelOfType(type, providerId, modelId);
		if (!model) {
			const actualType = MODEL_TYPES.find(
				(other) => other !== type && models.getModelOfType(other, providerId, modelId) !== undefined,
			);
			throw new Error(
				actualType
					? `"${providerId}/${modelId}" is ${withArticle(actualType)} model, not ${withArticle(type)} model. ${listHint}`
					: `Unknown ${type} model "${providerId}/${modelId}". ${listHint}`,
			);
		}
		const checked = checkContext(context);
		const record: CodemodeNestedCall = {
			id: `${id}/${name}/${++count}`,
			name,
			args: `${model.provider}/${model.id}`,
			status: "running",
		};
		calls.push(record);
		publish();
		const start = performance.now();
		const result = await limit(() => run(model, checked));
		record.durationMs = performance.now() - start;
		record.status = result.stopReason === "stop" ? "ok" : result.stopReason === "aborted" ? "cancelled" : "error";
		if (result.errorMessage) record.error = result.errorMessage.slice(0, 500);
		if (result.usage) {
			record.cost = result.usage.cost.total;
			addUsage(result.usage);
		}
		publish();
		return result;
	};
	return [
		{
			name: "models.getModelsOfType",
			spread: true,
			execute: (args) => {
				const [type, source] = args as unknown[];
				return models.getModelsOfType(modelType(type), provider(source)).map(toCodemodeModelInfo);
			},
		},
		{
			name: "models.getAvailableOfType",
			spread: true,
			execute: async (args, { signal }) => {
				const [type, source] = args as unknown[];
				return (await models.getAvailableOfType(modelType(type), provider(source), { signal })).map(
					toCodemodeModelInfo,
				);
			},
		},
		{
			name: "models.getModelOfType",
			spread: true,
			execute: (args) => {
				const [type, source, modelId] = args as unknown[];
				if (typeof source !== "string" || typeof modelId !== "string")
					throw new Error(
						`models.getModelOfType(type, provider, id) expects three strings, got (${(args as unknown[]).map(describeValue).join(", ")}). The provider and the id are separate arguments, for example models.getModelOfType("classifier", "typesafe", "jev-latest").`,
					);
				const model = models.getModelOfType(modelType(type), source, modelId);
				return model ? toCodemodeModelInfo(model) : undefined;
			},
		},
		{
			name: "models.classify",
			spread: true,
			execute: (args, { signal }) =>
				runModelCall("models.classify", "classifier", args as unknown[], checkClassifierContext, (model, context) =>
					models.classify(model, context, { signal }),
				),
		},
		{
			name: "models.generateImages",
			spread: true,
			execute: (args, { signal }) =>
				runModelCall(
					"models.generateImages",
					"image",
					args as unknown[],
					checkImagesContext,
					async (model, context) => {
						const result = await models.generateImages(model, context, { signal });
						addGeneratedImages(result.output.filter((block) => block.type === "image").length);
						return result;
					},
				),
		},
	];
}

export async function executeCodemode(
	id: string,
	input: CodemodeToolInput,
	signal: AbortSignal | undefined,
	update: ((result: AgentToolResult<CodemodeToolDetails>) => void) | undefined,
	ctx: ExtensionToolContext | undefined,
	options: CodemodeToolOptions = {},
): Promise<AgentToolResult<CodemodeToolDetails>> {
	const start = performance.now();
	const { code, options: source } = parseCodemodeSource(input.code);
	const calls: CodemodeNestedCall[] = [];
	let usage: Usage | undefined;
	let generatedImages = 0;
	const snapshot = (): CodemodeToolDetails => ({ calls: calls.map((call) => ({ ...call })) });
	const publish = () => update?.({ content: [], details: snapshot() });
	const callable = ctx ? getCodemodeCallableTools(ctx.tools) : [];
	const samples = new Map(callable.map((tool) => [tool.name, renderToolSample(toCodemodeDeclaration(tool))]));
	const sandbox = new CodemodeSandbox({
		tools: callable.map((tool) => ({
			name: tool.name,
			description: samples.get(tool.name),
			execute: async (args, { signal: callSignal }) => {
				const record: CodemodeNestedCall = {
					id: `${id}/?`,
					name: tool.name,
					args: preview(args),
					status: "running",
				};
				calls.push(record);
				publish();
				const started = performance.now();
				if (!ctx) throw new Error("Tool calls need a session");
				const outcome = await ctx.executeTool(tool.name, args, { signal: callSignal });
				record.id = outcome.toolCall.id;
				record.durationMs = performance.now() - started;
				record.status = outcome.isError ? (callSignal.aborted ? "cancelled" : "error") : "ok";
				const text = textOf(outcome.result);
				if (outcome.isError) record.error = (text || `Tool ${tool.name} failed`).slice(0, 500);
				publish();
				if (tool.outputSchema && outcome.result.structuredContent !== undefined)
					return outcome.result.structuredContent;
				if (outcome.isError) throw new Error(text || `Tool ${tool.name} failed`);
				return text;
			},
		})),
		globals: [
			...discoveryGlobals(callable, samples, options),
			...(options.models && ctx
				? modelGlobals(
						ctx,
						id,
						calls,
						publish,
						(extra) => {
							usage = usage ? combineUsage(usage, extra) : extra;
						},
						(count) => {
							generatedImages += count;
						},
					)
				: []),
		],
		timeoutMs: source.timeoutMs ?? Number.POSITIVE_INFINITY,
		memoryLimitBytes: 256 * 1024 * 1024,
		wasm: loadQuickJSWasm(getQuickJSWasmPath()),
		workerUrl: getCodemodeWorkerUrl(),
	});
	let result: CodemodeResult;
	try {
		result = await sandbox.execute(code, {
			signal,
			store: ctx ? readCodemodeStore(ctx.sessionManager.getBranch()) : {},
		});
	} finally {
		await sandbox.close();
	}
	for (const call of calls) if (call.status === "running") call.status = "cancelled";
	let content: (TextContent | ImageContent)[] = [...result.output];
	if (result.ok) {
		if (Object.keys(result.storeWrites.set).length || result.storeWrites.delete.length)
			options.appendEntry?.(CODEMODE_STORE_ENTRY_TYPE, result.storeWrites);
		if (result.value !== undefined)
			content.push({
				type: "text",
				text:
					typeof result.value === "string" ? result.value : (JSON.stringify(result.value) ?? String(result.value)),
			});
	} else
		content.push({
			type: "text",
			text: `Script error:\n${result.error.stack ?? result.error.message}\n\nTool calls made before the failure (they are not undone): ${calls.map((call) => `${call.name} (${call.status})`).join(", ") || "none"}`,
		});
	if (generatedImages > 0 && !content.some((block) => block.type === "image"))
		content.push({
			type: "text",
			text: `Note: models.generateImages() returned ${generatedImages} image${generatedImages === 1 ? "" : "s"} that the script did not show. Show each image block of result.output with image(block).`,
		});
	const text = content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	const budget = (source.maxOutputTokens ?? 10_000) * 4;
	const details = snapshot();
	if (text.length > budget) {
		const path = join(tmpdir(), `atomic-codemode-${randomBytes(8).toString("hex")}.txt`);
		let notice: string;
		try {
			await writeFile(path, text);
			details.fullOutputPath = path;
			notice = `Full output: ${path}`;
		} catch (error) {
			notice = `Could not save full output: ${error instanceof Error ? error.message : String(error)}`;
		}
		const head = Math.floor(budget / 2);
		const tail = budget - head;
		content = [
			{
				type: "text",
				text: `Warning: truncated output (original token count: ${Math.ceil(text.length / 4)})\n${text.slice(0, head)}\n... output truncated ...\n${tail ? text.slice(-tail) : ""}\n${notice}`,
			},
			...content.filter((block) => block.type === "image"),
		];
	}
	return {
		content: [
			{
				type: "text",
				text: `${result.ok ? "Script completed" : "Script failed"}\nWall time ${((performance.now() - start) / 1000).toFixed(1)} seconds\nOutput:\n`,
			},
			...content,
		],
		details,
		...(usage ? { usage } : {}),
		...(result.ok ? {} : { isError: true }),
	};
}
