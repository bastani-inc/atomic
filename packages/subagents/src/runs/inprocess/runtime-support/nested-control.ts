import * as fs from "node:fs";
import * as path from "node:path";
import {
	appendInProcessControlRequest,
	appendInProcessControlResult,
	hasInProcessNestedRoute,
	readInProcessControlRequests,
	readInProcessControlResults,
} from "../nested-routing.ts";
import {
	assertSafeId,
	clampNumber,
	containedPath,
	isSafeNestedId,
	MAX_NESTED_EVENT_BYTES,
	type NestedControlRequestRecord,
	type NestedControlResultRecord,
	type NestedRoute,
	stringValue,
	validateRouteShape,
} from "./nested-core.ts";
import { writeRouteRecord } from "./nested-registry.ts";

export function parseNestedControlRequest(content: string, route: NestedRoute): NestedControlRequestRecord | undefined {
	if (Buffer.byteLength(content, "utf-8") > MAX_NESTED_EVENT_BYTES) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object") return undefined;
	const raw = parsed as Record<string, unknown>;
	if (raw.type !== "subagent.nested.control-request") return undefined;
	if (raw.rootRunId !== route.rootRunId || raw.capabilityToken !== route.capabilityToken) return undefined;
	if (!isSafeNestedId(raw.requestId) || !isSafeNestedId(raw.targetRunId)) return undefined;
	if (raw.action !== "interrupt" && raw.action !== "resume") return undefined;
	const ts = clampNumber(raw.ts);
	if (ts === undefined) return undefined;
	return {
		type: "subagent.nested.control-request",
		ts,
		rootRunId: route.rootRunId,
		capabilityToken: route.capabilityToken,
		requestId: raw.requestId,
		targetRunId: raw.targetRunId,
		action: raw.action,
		...(stringValue(raw.message, 16_000) ? { message: stringValue(raw.message, 16_000) } : {}),
	};
}

export function parseNestedControlResult(content: string, route: NestedRoute): NestedControlResultRecord | undefined {
	if (Buffer.byteLength(content, "utf-8") > MAX_NESTED_EVENT_BYTES) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object") return undefined;
	const raw = parsed as Record<string, unknown>;
	if (raw.type !== "subagent.nested.control-result") return undefined;
	if (raw.rootRunId !== route.rootRunId || raw.capabilityToken !== route.capabilityToken) return undefined;
	if (!isSafeNestedId(raw.requestId) || !isSafeNestedId(raw.targetRunId)) return undefined;
	const ts = clampNumber(raw.ts);
	if (ts === undefined || typeof raw.ok !== "boolean") return undefined;
	return {
		type: "subagent.nested.control-result",
		ts,
		rootRunId: route.rootRunId,
		capabilityToken: route.capabilityToken,
		requestId: raw.requestId,
		targetRunId: raw.targetRunId,
		ok: raw.ok,
		message: stringValue(raw.message, 16_000) ?? (raw.ok ? "Control request completed." : "Control request failed."),
	};
}

export function writeNestedControlRequest(
	route: NestedRoute,
	request: Omit<NestedControlRequestRecord, "type" | "rootRunId" | "capabilityToken">,
): string {
	validateRouteShape(route);
	assertSafeId("requestId", request.requestId);
	assertSafeId("targetRunId", request.targetRunId);
	const record: NestedControlRequestRecord = {
		type: "subagent.nested.control-request",
		...request,
		rootRunId: route.rootRunId,
		capabilityToken: route.capabilityToken,
	};
	const sanitized = parseNestedControlRequest(JSON.stringify(record), route);
	if (!sanitized) throw new Error("Nested control request failed validation.");
	const filePath = writeRouteRecord(route.controlInbox, sanitized.ts, sanitized);
	appendInProcessControlRequest(route, { ...sanitized, filePath });
	return filePath;
}

export function readNestedControlRequests(
	route: NestedRoute,
): Array<NestedControlRequestRecord & { filePath: string }> {
	validateRouteShape(route);
	if (hasInProcessNestedRoute(route)) return [...readInProcessControlRequests(route)];
	let entries: string[] = [];
	try {
		entries = fs
			.readdirSync(route.controlInbox)
			.filter((entry) => entry.endsWith(".json"))
			.sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const requests: Array<NestedControlRequestRecord & { filePath: string }> = [];
	for (const entry of entries) {
		const filePath = path.join(route.controlInbox, entry);
		if (!containedPath(route.controlInbox, filePath)) continue;
		try {
			const stat = fs.statSync(filePath);
			if (!stat.isFile() || stat.size > MAX_NESTED_EVENT_BYTES) continue;
			const request = parseNestedControlRequest(fs.readFileSync(filePath, "utf-8"), route);
			if (request) requests.push({ ...request, filePath });
		} catch {}
	}
	return requests;
}

export function writeNestedControlResult(
	route: NestedRoute,
	result: Omit<NestedControlResultRecord, "type" | "rootRunId" | "capabilityToken">,
): void {
	validateRouteShape(route);
	assertSafeId("requestId", result.requestId);
	assertSafeId("targetRunId", result.targetRunId);
	const record: NestedControlResultRecord = {
		type: "subagent.nested.control-result",
		...result,
		rootRunId: route.rootRunId,
		capabilityToken: route.capabilityToken,
	};
	const sanitized = parseNestedControlResult(JSON.stringify(record), route);
	if (!sanitized) throw new Error("Nested control result failed validation.");
	const filePath = writeRouteRecord(route.eventSink, sanitized.ts, sanitized);
	appendInProcessControlResult(route, { ...sanitized, filePath });
}

export function readNestedControlResults(route: NestedRoute): NestedControlResultRecord[] {
	validateRouteShape(route);
	if (hasInProcessNestedRoute(route)) return [...readInProcessControlResults(route)] as NestedControlResultRecord[];
	let entries: string[] = [];
	try {
		entries = fs
			.readdirSync(route.eventSink)
			.filter((entry) => entry.endsWith(".json") || entry.endsWith(".jsonl"))
			.sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const results: NestedControlResultRecord[] = [];
	for (const entry of entries) {
		const eventPath = path.join(route.eventSink, entry);
		if (!containedPath(route.eventSink, eventPath)) continue;
		try {
			const stat = fs.statSync(eventPath);
			if (!stat.isFile() || stat.size > MAX_NESTED_EVENT_BYTES) continue;
			const content = fs.readFileSync(eventPath, "utf-8");
			const lines = content.includes("\n") ? content.split("\n").filter((line) => line.trim()) : [content];
			for (const line of lines) {
				const result = parseNestedControlResult(line, route);
				if (result) results.push(result);
			}
		} catch {}
	}
	return results;
}

export function nestedRouteEnv(_route: NestedRoute): Record<string, string> {
	return {};
}
