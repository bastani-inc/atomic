import { hash } from "fast-sha256";
import type { SessionEntry } from "../../session-manager-types.ts";
import type {
	ArchivedChildCatalogEntry,
	ArchivedSubagentCapture,
	SessionChildAliases,
	SessionStoredEntry,
} from "./types.js";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const keyOf = (owner: string, child: string) => JSON.stringify([owner, child]);
// Unknown legacy fields must survive a later partial observation, but their field names are not addresses.
const fieldKey = (k: string) =>
	k.length <= 128 ? `:${k}` : `#${Buffer.from(hash(Buffer.from(k, "utf16le"))).toString("base64url")}`;
const strings = [
	"terminalStatus",
	"taskId",
	"childSessionId",
	"childSessionFile",
	"intercomTarget",
	"intercomGroup",
	"releasedIntercomId",
] as const;
interface Child {
	heading: ArchivedChildCatalogEntry;
	ownerKind?: string;
	latest: number;
	first: number;
	fields: Map<string, number>;
	waits: Set<string>;
	wakeTask?: string;
	wake: boolean;
	heldTask?: string;
	held: boolean;
	eligible: boolean;
}

/** A catalogue contains no arbitrary entry data, launch prompts, messages or tool results. The locations
 * of contributing observations are enough to recover even partial records written by older clients. */
export class ChildCatalog {
	private groups = new Map<string, Child>();
	private byEntry = new Map<string, Child>();
	private published: readonly ArchivedChildCatalogEntry[] = [];
	/**
	 * Captures named by records retired from the window while on the active branch, each from the record that names it,
	 * and the first entry of the window they preceded: they stay on the branch while that entry is on it.
	 */
	private captures: Map<string, ArchivedSubagentCapture> | undefined;
	private captureAnchor: string | undefined;
	static inspect(entry: SessionEntry) {
		if (entry.type !== "custom" || entry.customType !== "subagent-child") return;
		const d = obj(entry.data),
			o = obj(d.owner);
		if (
			d.version !== 1 ||
			typeof d.childId !== "string" ||
			typeof d.runId !== "string" ||
			typeof d.index !== "number" ||
			typeof d.agent !== "string" ||
			typeof d.cwd !== "string" ||
			(d.state !== "running" && d.state !== "terminal") ||
			typeof o.sessionId !== "string"
		)
			return;
		return {
			d,
			o,
			key: keyOf(o.sessionId, d.childId),
			owner: o.sessionId,
			child: d.childId,
			run: d.runId,
			index: d.index,
			agent: d.agent,
			cwd: d.cwd,
			state: d.state as "running" | "terminal",
		};
	}
	/** Drop payloads before advancing to the next archive page. Keep field presence and delivery guards. */
	static headingOnly(entry: SessionEntry): SessionEntry {
		const s = ChildCatalog.inspect(entry);
		if (!s || entry.type !== "custom")
			return {
				type: "custom",
				customType: "subagent-child",
				id: entry.id,
				parentId: entry.parentId,
				timestamp: entry.timestamp,
			};
		const { d, o } = s;
		const projected: Record<string, unknown> = Object.create(null);
		for (const field of Object.keys(d)) projected[field] = null;
		for (const key of [
			"version",
			"childId",
			"runId",
			"index",
			"agent",
			"cwd",
			"state",
			"elapsedMs",
			"worktreeCapturedAt",
			...strings,
		])
			if (Object.hasOwn(d, key))
				projected[key] = typeof d[key] === "string" || typeof d[key] === "number" ? d[key] : null;
		projected.owner = { kind: o.kind, sessionId: o.sessionId };
		if (d.worktree) projected.worktree = { named: !!obj(d.worktree).named };
		if (d.elapsedSpan) {
			const s = obj(d.elapsedSpan);
			projected.elapsedSpan = { dispatchedAt: s.dispatchedAt, endedAt: s.endedAt };
		}
		for (const key of ["waitingOn", "heldToolResults", "stillRunning"])
			if (Object.hasOwn(d, key)) projected[key] = Array.isArray(d[key]) && d[key].length ? [true] : [];
		if (d.wakeFailure) projected.wakeFailure = { taskId: obj(d.wakeFailure).taskId };
		if (d.heldMessages) {
			const h = obj(d.heldMessages);
			projected.heldMessages = {
				taskId: h.taskId,
				messages: Array.isArray(h.messages) && h.messages.length ? [true] : [],
			};
		}
		return {
			type: "custom",
			customType: "subagent-child",
			id: entry.id,
			parentId: entry.parentId,
			timestamp: entry.timestamp,
			data: projected,
		};
	}
	noteResident(entry: SessionEntry, seq: number) {
		if (!this.groups.size || entry.type !== "custom" || entry.customType !== "subagent-child") return;
		const s = ChildCatalog.inspect(entry),
			c = s && this.groups.get(s.key);
		if (!s || !c || seq <= c.latest) return;
		const keys = new Set(Object.keys(s.d).map(fieldKey));
		if ([...c.fields.keys()].every((k) => keys.has(k))) {
			c.heading = { ...c.heading, coveredBy: entry.id };
			this.publish();
		}
	}
	private observe(entry: SessionEntry, seq: number): string | undefined {
		const s = ChildCatalog.inspect(entry);
		if (!s) return;
		const { key, d, o } = s;
		let record = this.groups.get(key);
		if (record && seq <= record.latest) return key;
		const p = record?.heading;
		const taskIds = p ? [...p.taskIds] : [];
		if (typeof d.taskId === "string" && !taskIds.includes(d.taskId)) taskIds.push(d.taskId);
		const heading: ArchivedChildCatalogEntry = {
			...p,
			entryId: entry.id,
			coveredBy: undefined,
			firstSeq: record?.first ?? seq,
			childId: s.child,
			ownerSessionId: s.owner,
			runId: s.run,
			index: s.index,
			agent: s.agent,
			cwd: s.cwd,
			state: s.state,
			taskIds,
		};
		const extras: Record<string, unknown> = {};
		let valid = true;
		for (const k of strings)
			if (Object.hasOwn(d, k)) {
				if (typeof d[k] === "string") extras[k] = d[k];
				else valid = false;
			}
		if (Object.hasOwn(d, "elapsedMs")) {
			if (typeof d.elapsedMs === "number") extras.elapsedMs = d.elapsedMs;
			else valid = false;
		}
		if (Object.hasOwn(d, "elapsedSpan")) {
			const span = obj(d.elapsedSpan);
			if (d.elapsedSpan === null) extras.elapsedSpan = null;
			else if (
				typeof span.dispatchedAt === "number" &&
				(span.endedAt === undefined || typeof span.endedAt === "number")
			)
				extras.elapsedSpan = {
					dispatchedAt: span.dispatchedAt,
					...(span.endedAt === undefined ? {} : { endedAt: span.endedAt }),
				};
			else valid = false;
		}
		if (Object.hasOwn(d, "worktree")) extras.managedWorktree = !!d.worktree && !obj(d.worktree).named;
		Object.assign(heading, extras);
		if (heading.taskId !== undefined) {
			const released = new Set(p?.releasedTaskIds);
			if (heading.state === "terminal" && heading.terminalStatus === "released") released.add(heading.taskId);
			else released.delete(heading.taskId);
			Object.assign(heading, { releasedTaskIds: released.size ? [...released] : undefined });
		}
		if (!record) {
			record = {
				heading,
				latest: seq,
				first: seq,
				fields: new Map(),
				waits: new Set(),
				wake: false,
				held: false,
				eligible: true,
			};
			this.groups.set(key, record);
		}
		record.latest = seq;
		record.heading = heading;
		record.ownerKind = typeof o.kind === "string" ? o.kind : undefined;
		record.eligible &&= valid;
		for (const k of Object.keys(d)) record.fields.set(fieldKey(k), seq);
		for (const k of ["waitingOn", "heldToolResults", "stillRunning"])
			if (Object.hasOwn(d, k)) {
				if (Array.isArray(d[k]) && d[k].length) record.waits.add(k);
				else record.waits.delete(k);
			}
		if (Object.hasOwn(d, "wakeFailure")) {
			record.wake = !!d.wakeFailure;
			const t = obj(d.wakeFailure).taskId;
			record.wakeTask = typeof t === "string" ? t : undefined;
		}
		if (Object.hasOwn(d, "heldMessages")) {
			const h = obj(d.heldMessages);
			record.held = Array.isArray(h.messages) && h.messages.length > 0;
			record.heldTask = typeof h.taskId === "string" ? h.taskId : undefined;
		}
		return key;
	}
	/** Ingest saved state, preserving any older contributing positions already retired by this manager.
	 * Never retire a current-window entry, a live/released/paused/quit child or its unsettled deliveries. */
	/**
	 * `onBranch` says whether a retired record is on the active branch when its state entry does not; it is asked only
	 * for records of children that name a capture.
	 */
	retire(
		state: readonly (SessionStoredEntry & { readonly onBranch?: boolean })[],
		branch: readonly SessionStoredEntry[],
		onBranch?: (entryId: string) => boolean,
	): Set<string> {
		const current = new Set<string>(),
			candidates = new Map<string, string[]>();
		for (const { entry } of branch) {
			const s = ChildCatalog.inspect(entry);
			if (s) current.add(s.key);
		}
		for (const { entry, seq } of state) {
			const s = ChildCatalog.inspect(entry);
			if (!s || current.has(s.key)) continue;
			const key = this.observe(entry, seq)!;
			const ids = candidates.get(key) ?? [];
			ids.push(entry.id);
			candidates.set(key, ids);
		}
		const retired = new Set<string>();
		for (const [key, ids] of candidates) {
			const c = this.groups.get(key)!;
			const h = c.heading;
			if (
				c.eligible &&
				c.ownerKind === "session" &&
				h.state === "terminal" &&
				!["released", "paused", "quit", "stage-paused"].includes(h.terminalStatus ?? "") &&
				!c.waits.size &&
				!(c.wake && c.wakeTask === h.taskId) &&
				!(c.held && c.heldTask === h.taskId)
			)
				for (const id of ids) retired.add(id);
			else this.groups.delete(key);
		}
		// Captures retired by an earlier cut stay only while the window they preceded is still on the active branch; every
		// capture kept then precedes this cut's window too. Nothing here runs for a session whose children captured nothing.
		const anchor = branch[0]?.entry.id;
		if (this.captures !== undefined && this.captureAnchor !== anchor) {
			const kept = this.captureAnchor !== undefined && onBranch?.(this.captureAnchor) === true;
			if (!kept) this.captures = undefined;
		}
		if (retired.size > 0)
			for (const item of state) {
				if (!retired.has(item.entry.id)) continue;
				const capture = ChildCatalog.capture(item.entry);
				if (capture === undefined || (item.onBranch ?? onBranch?.(item.entry.id)) !== true) continue;
				const known = this.captures?.get(capture.childSessionId);
				if (known !== undefined && Date.parse(capture.worktreeCapturedAt) <= Date.parse(known.worktreeCapturedAt))
					continue;
				this.captures ??= new Map();
				this.captures.set(capture.childSessionId, capture);
			}
		this.captureAnchor = this.captures !== undefined ? anchor : undefined;
		this.publish();
		return retired;
	}
	/** The capture a child's record itself names: its own session in the owner's store, and when it captured. */
	private static capture(entry: SessionEntry): ArchivedSubagentCapture | undefined {
		const s = ChildCatalog.inspect(entry);
		if (!s) return undefined;
		const { d } = s;
		if (typeof d.childSessionId !== "string" || d.childSessionFile !== undefined) return undefined;
		if (typeof d.worktreeCapturedAt !== "string") return undefined;
		return {
			ownerSessionId: s.owner,
			childSessionId: d.childSessionId,
			cwd: s.cwd,
			worktreeCapturedAt: d.worktreeCapturedAt,
		};
	}
	/** Captures of retired records on the active branch, and the window entry they preceded; see `retire`. */
	archivedCaptures(): { readonly anchor?: string; readonly captures: readonly ArchivedSubagentCapture[] } {
		return this.captureAnchor === undefined
			? { captures: [] }
			: { anchor: this.captureAnchor, captures: [...(this.captures?.values() ?? [])] };
	}
	/** Direct, read-only catalogue scans include live children as well. */
	add(entry: SessionEntry, seq: number) {
		this.observe(entry, seq);
	}
	publish() {
		this.byEntry = new Map([...this.groups.values()].map((child) => [child.heading.entryId, child]));
		this.published = Object.freeze(
			[...this.groups.values()]
				.sort((a, b) => a.first - b.first)
				.map(({ heading }) => {
					Object.freeze(heading.taskIds);
					if (heading.releasedTaskIds) Object.freeze(heading.releasedTaskIds);
					if (heading.elapsedSpan) Object.freeze(heading.elapsedSpan);
					return Object.freeze(heading);
				}),
		);
	}
	applyAliases(aliases: Readonly<Record<string, SessionChildAliases>>) {
		for (const [key, c] of this.groups) {
			const a = aliases[key];
			if (a)
				c.heading = {
					...c.heading,
					taskIds: [...a.taskIds],
					releasedTaskIds: a.releasedTaskIds.length ? [...a.releasedTaskIds] : undefined,
				};
		}
		this.publish();
	}
	rows(): readonly ArchivedChildCatalogEntry[] {
		return this.published;
	}
	positions(id: string): readonly number[] | undefined {
		const c = this.byEntry.get(id);
		return c ? [...new Set([c.first, ...c.fields.values()])].sort((a, b) => a - b) : undefined;
	}
}
