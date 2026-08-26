import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { arch as hostArchitecture, platform as hostPlatform } from "node:os";
import { dirname, join } from "node:path";
import type { EnvironmentBinding } from "../../shared/types.js";

const SESSION_TOKEN_HEADER = "Coder-Session-Token";
const JSON_HEADERS = { Accept: "application/json", "Content-Type": "application/json" } as const;

export interface CoderWorkspace {
	readonly id: string;
	readonly latestBuildId: string;
}

export interface CoderBuild {
	readonly id: string;
}

export interface CoderBuildRequest {
	readonly transition: "start" | "stop" | "delete";
	readonly templateVersionId?: string;
	readonly templateVersionPresetId?: string;
	readonly richParameterValues?: readonly CoderParameterValue[];
}

export interface CoderParameterValue {
	readonly name: string;
	readonly value: string;
}

export interface WaitForAgentReadyOptions {
	readonly timeoutMs: number;
	readonly agentName?: string;
}

export interface CoderWebSocket {
	readonly OPEN: number;
	readonly readyState: number;
	addEventListener(type: string, listener: (event: Event | MessageEvent) => void): void;
	removeEventListener(type: string, listener: (event: Event | MessageEvent) => void): void;
	close(): void;
}

export type CoderFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface CreateCoderClientOptions {
	readonly deployment: string;
	readonly sessionToken: string;
	readonly fetch?: CoderFetch;
	readonly webSocket?: (url: string, headers: Readonly<Record<string, string>>) => CoderWebSocket;
}

export class CoderApiError extends Error {
	constructor(
		message: string,
		readonly status?: number,
		readonly detail?: string,
	) {
		super(message);
		this.name = "CoderApiError";
	}
}

export class CoderAgentStartTimeoutError extends Error {
	constructor(readonly timeoutMs: number) {
		super(`Coder workspace agent did not become ready within ${timeoutMs}ms`);
		this.name = "CoderAgentStartTimeoutError";
	}
}

export class CoderAgentStartError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CoderAgentStartError";
	}
}

export interface CoderClient {
	createWorkspace(name: string, binding: EnvironmentBinding, signal: AbortSignal): Promise<CoderWorkspace>;
	createBuild(workspaceId: string, request: CoderBuildRequest, signal: AbortSignal): Promise<CoderBuild>;
	waitForAgentReady(workspaceId: string, options: WaitForAgentReadyOptions, signal: AbortSignal): Promise<void>;
	stopWorkspace(workspaceId: string, signal: AbortSignal): Promise<CoderBuild>;
	deleteWorkspace(workspaceId: string, signal: AbortSignal): Promise<CoderBuild>;
}

interface JsonObject {
	readonly [key: string]: JsonValue;
}
type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;

function isObject(value: JsonValue): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: JsonValue, field: string, context: string): string {
	if (!isObject(value) || typeof value[field] !== "string" || value[field].length === 0) {
		throw new CoderApiError(`Coder returned an invalid ${context}: missing ${field}`);
	}
	return value[field];
}

function arrayField(value: JsonValue, field: string, context: string): readonly JsonValue[] {
	if (!isObject(value) || !Array.isArray(value[field])) {
		throw new CoderApiError(`Coder returned an invalid ${context}: missing ${field}`);
	}
	return value[field];
}

function deploymentUrl(deployment: string, path: string): URL {
	const base = new URL(deployment);
	base.pathname = `${base.pathname.replace(/\/$/u, "")}/${path.replace(/^\//u, "")}`;
	base.search = "";
	base.hash = "";
	return base;
}

function segment(value: string): string {
	return encodeURIComponent(value);
}

function defaultWebSocket(url: string, headers: Readonly<Record<string, string>>): CoderWebSocket {
	interface WebSocketWithHeadersConstructor {
		new (url: string, options: { readonly headers: Readonly<Record<string, string>> }): CoderWebSocket;
	}
	const Constructor = globalThis.WebSocket as unknown as WebSocketWithHeadersConstructor;
	if (Constructor === undefined) throw new CoderApiError("This runtime cannot open the Coder agent readiness watch");
	return new Constructor(url, { headers });
}

async function responseJson(response: Response, context: string): Promise<JsonValue> {
	if (!response.ok) {
		const detail = await response.text();
		throw new CoderApiError(`Coder ${context} failed with HTTP ${response.status}`, response.status, detail);
	}
	try {
		return (await response.json()) as JsonValue;
	} catch (error) {
		throw new CoderApiError(
			`Coder returned invalid JSON for ${context}`,
			response.status,
			error instanceof Error ? error.message : String(error),
		);
	}
}

function requestBody(request: CoderBuildRequest): JsonObject {
	return {
		transition: request.transition,
		...(request.templateVersionId === undefined ? {} : { template_version_id: request.templateVersionId }),
		...(request.templateVersionPresetId === undefined
			? {}
			: { template_version_preset_id: request.templateVersionPresetId }),
		...(request.richParameterValues === undefined
			? {}
			: {
					rich_parameter_values: request.richParameterValues.map(({ name, value }) => ({ name, value })),
				}),
	};
}

export function createCoderClient(options: CreateCoderClientOptions): CoderClient {
	const requestFetch = options.fetch ?? globalThis.fetch;
	const openWebSocket = options.webSocket ?? defaultWebSocket;
	const headers = { ...JSON_HEADERS, [SESSION_TOKEN_HEADER]: options.sessionToken };

	const request = async (path: string, init: RequestInit, context: string): Promise<JsonValue> => {
		const response = await requestFetch(deploymentUrl(options.deployment, path), {
			...init,
			headers: { ...headers, ...init.headers },
		});
		return responseJson(response, context);
	};

	const get = (path: string, signal: AbortSignal, context: string): Promise<JsonValue> =>
		request(path, { method: "GET", signal }, context);

	const post = (path: string, body: JsonObject, signal: AbortSignal, context: string): Promise<JsonValue> =>
		request(path, { method: "POST", body: JSON.stringify(body), signal }, context);

	const resolveOrganizationId = async (binding: EnvironmentBinding, signal: AbortSignal): Promise<string> => {
		if (binding.organization !== undefined) {
			const organization = await get(
				`api/v2/organizations/${segment(binding.organization)}`,
				signal,
				`resolve organization ${binding.organization}`,
			);
			return stringField(organization, "id", "organization");
		}

		const user = await get("api/v2/users/me", signal, "resolve current user");
		const firstOrganizationId = arrayField(user, "organization_ids", "current user")[0];
		if (typeof firstOrganizationId !== "string" || firstOrganizationId.length === 0) {
			throw new CoderApiError("The current Coder user belongs to no organization");
		}
		return firstOrganizationId;
	};

	const createBuild = async (
		workspaceId: string,
		buildRequest: CoderBuildRequest,
		signal: AbortSignal,
	): Promise<CoderBuild> => {
		const value = await post(
			`api/v2/workspaces/${segment(workspaceId)}/builds`,
			requestBody(buildRequest),
			signal,
			`create ${buildRequest.transition} build`,
		);
		return { id: stringField(value, "id", "workspace build") };
	};

	return {
		async createWorkspace(name, binding, signal) {
			const organizationId = await resolveOrganizationId(binding, signal);
			const template = await get(
				`api/v2/organizations/${segment(organizationId)}/templates/${segment(binding.template)}`,
				signal,
				`resolve template ${binding.template}`,
			);
			const versionId = stringField(template, "active_version_id", "template");
			const richParameters = await get(
				`api/v2/templateversions/${segment(versionId)}/rich-parameters`,
				signal,
				"resolve template parameters",
			);
			if (!Array.isArray(richParameters)) throw new CoderApiError("Coder returned invalid template parameters");

			let presetId: string | undefined;
			const presetValues = new Map<string, string>();
			if (binding.preset !== undefined) {
				const presets = await get(
					`api/v2/templateversions/${segment(versionId)}/presets`,
					signal,
					"resolve template presets",
				);
				if (!Array.isArray(presets)) throw new CoderApiError("Coder returned invalid template presets");
				const preset = presets.find((candidate) => isObject(candidate) && candidate.name === binding.preset);
				if (preset === undefined) {
					throw new CoderApiError(`Coder template ${binding.template} has no preset named ${binding.preset}`);
				}
				presetId = stringField(preset, "id", "template preset");
				for (const parameter of arrayField(preset, "parameters", "template preset")) {
					presetValues.set(
						stringField(parameter, "name", "preset parameter"),
						stringField(parameter, "value", "preset parameter"),
					);
				}
			}

			const richParameterValues = richParameters.map((parameter): CoderParameterValue => {
				const parameterName = stringField(parameter, "name", "template parameter");
				const configured = binding.parameters[parameterName];
				return {
					name: parameterName,
					value:
						configured ??
						presetValues.get(parameterName) ??
						stringField(parameter, "default_value", "template parameter"),
				};
			});
			for (const configuredName of Object.keys(binding.parameters)) {
				if (!richParameterValues.some(({ name: parameterName }) => parameterName === configuredName)) {
					throw new CoderApiError(
						`Coder template ${binding.template} has no rich parameter named ${configuredName}`,
					);
				}
			}

			const value = await post(
				"api/v2/users/me/workspaces",
				{
					name,
					rich_parameter_values: richParameterValues.map(({ name: parameterName, value: parameterValue }) => ({
						name: parameterName,
						value: parameterValue,
					})),
					template_version_id: versionId,
					...(presetId === undefined ? {} : { template_version_preset_id: presetId }),
					ttl_ms: binding.idleMinutes * 60_000,
				},
				signal,
				"create workspace",
			);
			const latestBuild = isObject(value) ? value.latest_build : undefined;
			return {
				id: stringField(value, "id", "workspace"),
				latestBuildId: stringField(latestBuild ?? null, "id", "workspace latest build"),
			};
		},
		createBuild,
		async waitForAgentReady(workspaceId, waitOptions, signal) {
			if (!Number.isFinite(waitOptions.timeoutMs) || waitOptions.timeoutMs <= 0) {
				throw new TypeError("Coder agent readiness timeout must be positive");
			}
			if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
			const watch = deploymentUrl(
				options.deployment,
				`api/v2/workspaces/${segment(workspaceId)}/agent-connection-watch`,
			);
			watch.protocol = watch.protocol === "https:" ? "wss:" : "ws:";
			if (waitOptions.agentName !== undefined) watch.searchParams.set("agent_name", waitOptions.agentName);
			const socket = openWebSocket(watch.toString(), { [SESSION_TOKEN_HEADER]: options.sessionToken });

			await new Promise<void>((resolve, reject) => {
				let settled = false;
				const finish = (error?: Error): void => {
					if (settled) return;
					settled = true;
					clearTimeout(timeout);
					signal.removeEventListener("abort", onAbort);
					socket.removeEventListener("message", onMessage);
					socket.removeEventListener("error", onError);
					socket.removeEventListener("close", onClose);
					socket.close();
					if (error) reject(error);
					else resolve();
				};
				const onAbort = (): void => finish(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
				const onError = (): void => finish(new CoderAgentStartError("Coder agent readiness watch failed"));
				const onClose = (): void =>
					finish(new CoderAgentStartError("Coder agent readiness watch closed before ready"));
				const onMessage = (event: Event | MessageEvent): void => {
					if (!(event instanceof MessageEvent) || typeof event.data !== "string") return;
					let value: JsonValue;
					try {
						value = JSON.parse(event.data) as JsonValue;
					} catch {
						finish(new CoderAgentStartError("Coder agent readiness watch returned invalid JSON"));
						return;
					}
					if (!isObject(value)) return;
					if (isObject(value.error)) {
						const message = typeof value.error.message === "string" ? value.error.message : "unknown watch error";
						finish(new CoderAgentStartError(message));
						return;
					}
					if (
						isObject(value.build_update) &&
						["failed", "canceled"].includes(String(value.build_update.job_status))
					) {
						finish(new CoderAgentStartError(`Coder workspace build ${String(value.build_update.job_status)}`));
						return;
					}
					if (isObject(value.agent_update) && value.agent_update.lifecycle === "ready") finish();
				};
				const timeout = setTimeout(
					() => finish(new CoderAgentStartTimeoutError(waitOptions.timeoutMs)),
					waitOptions.timeoutMs,
				);
				signal.addEventListener("abort", onAbort, { once: true });
				socket.addEventListener("message", onMessage);
				socket.addEventListener("error", onError);
				socket.addEventListener("close", onClose);
				if (signal.aborted) onAbort();
			});
		},
		stopWorkspace: (workspaceId, signal) => createBuild(workspaceId, { transition: "stop" }, signal),
		deleteWorkspace: (workspaceId, signal) => createBuild(workspaceId, { transition: "delete" }, signal),
	};
}

export interface AcquireCoderCliOptions {
	readonly deployment: string;
	readonly cacheDirectory: string;
	readonly fetch?: CoderFetch;
	readonly platform?: NodeJS.Platform;
	readonly architecture?: string;
	readonly verifyBinary?: (path: string, deploymentVersion: string) => Promise<void>;
	readonly signal: AbortSignal;
}

function cliTarget(platform: NodeJS.Platform, architecture: string): { os: string; arch: string; extension: string } {
	const os = platform === "win32" ? "windows" : platform === "darwin" || platform === "linux" ? platform : undefined;
	const resolvedArchitecture = architecture === "x64" ? "amd64" : architecture === "arm" ? "armv7" : architecture;
	if (os === undefined || !["amd64", "arm64", "armv7"].includes(resolvedArchitecture)) {
		throw new CoderApiError(`Coder CLI does not support ${platform}/${architecture}`);
	}
	return { os, arch: resolvedArchitecture, extension: os === "windows" ? ".exe" : "" };
}

function safeCachePart(value: string, label: string): string {
	const normalized = value.replace(/^v/u, "");
	if (!/^[A-Za-z0-9._+-]+$/u.test(normalized)) throw new CoderApiError(`Coder returned an invalid ${label}`);
	return normalized;
}

function versionIdentity(value: string): string {
	const match = /v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/u.exec(value);
	if (match?.[1] === undefined) throw new CoderApiError(`Cannot read Coder version from ${JSON.stringify(value)}`);
	return match[1];
}

async function verifyCoderBinary(path: string, deploymentVersion: string): Promise<void> {
	const output = await new Promise<string>((resolve, reject) => {
		execFile(path, ["version"], { timeout: 30_000 }, (error, stdout, stderr) => {
			if (error) {
				reject(new CoderApiError(`Downloaded Coder CLI could not run: ${stderr.trim() || error.message}`));
				return;
			}
			resolve(`${stdout}\n${stderr}`);
		});
	});
	if (versionIdentity(output) !== versionIdentity(deploymentVersion)) {
		throw new CoderApiError(`Downloaded Coder CLI does not match deployment version ${deploymentVersion}`);
	}
}

export async function acquireCoderCli(options: AcquireCoderCliOptions): Promise<string> {
	const requestFetch = options.fetch ?? globalThis.fetch;
	const target = cliTarget(options.platform ?? hostPlatform(), options.architecture ?? hostArchitecture());
	const buildInfoResponse = await requestFetch(deploymentUrl(options.deployment, "api/v2/buildinfo"), {
		headers: { Accept: "application/json" },
		signal: options.signal,
	});
	const buildInfo = await responseJson(buildInfoResponse, "resolve deployment version");
	const deploymentId = safeCachePart(stringField(buildInfo, "deployment_id", "build info"), "deployment id");
	const deploymentVersion = stringField(buildInfo, "version", "build info");
	const versionDirectory = safeCachePart(deploymentVersion, "deployment version");
	const binaryName = `coder${target.extension}`;
	const destination = join(
		options.cacheDirectory,
		"coder",
		deploymentId,
		versionDirectory,
		`${target.os}-${target.arch}`,
		binaryName,
	);
	const verify = options.verifyBinary ?? verifyCoderBinary;
	if (existsSync(destination)) {
		try {
			await verify(destination, deploymentVersion);
			return destination;
		} catch {
			await rm(destination, { force: true });
		}
	}

	const response = await requestFetch(deploymentUrl(options.deployment, `bin/coder-${target.os}-${target.arch}`), {
		headers: { Accept: "application/octet-stream" },
		signal: options.signal,
	});
	if (!response.ok) {
		throw new CoderApiError(
			`Coder CLI download failed with HTTP ${response.status}`,
			response.status,
			await response.text(),
		);
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.byteLength === 0) throw new CoderApiError("Coder CLI download was empty");

	await mkdir(dirname(destination), { recursive: true });
	const temporary = `${destination}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	try {
		await writeFile(temporary, bytes, { mode: 0o755 });
		if (target.os !== "windows") await chmod(temporary, 0o755);
		try {
			await rename(temporary, destination);
		} catch (error) {
			if (!existsSync(destination)) throw error;
			try {
				await verify(destination, deploymentVersion);
				return destination;
			} catch {
				await rm(destination, { force: true });
				await rename(temporary, destination);
			}
		}
		try {
			await verify(destination, deploymentVersion);
		} catch (error) {
			await rm(destination, { force: true });
			throw error;
		}
		return destination;
	} finally {
		await rm(temporary, { force: true });
	}
}
