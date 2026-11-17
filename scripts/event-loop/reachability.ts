import type { CallGraph, EdgeKind, GraphFunction, SinkRegistration } from "./call-graph.ts";

export type Arrival =
	| { readonly kind: "root"; readonly reason: string }
	| { readonly kind: "edge"; readonly from: number; readonly edge: EdgeKind }
	| { readonly kind: "registered"; readonly from: number; readonly sink: string; readonly line: number };

export interface ReachOptions {
	readonly stopAt: ReadonlyMap<number, string>;
	readonly followRegistrations: boolean;
	readonly skipEdge?: (from: number, to: number, edge: EdgeKind) => boolean;
}

export interface Reached {
	readonly arrivals: ReadonlyMap<number, Arrival>;
	readonly stoppedFrom: ReadonlyMap<number, number>;
}

export function registrationsByRegistrar(graph: CallGraph): Map<number, SinkRegistration[]> {
	const index = new Map<number, SinkRegistration[]>();
	for (const registration of graph.sinkRegistrations) {
		const list = index.get(registration.registrar) ?? [];
		list.push(registration);
		index.set(registration.registrar, list);
	}
	return index;
}

export function reach(
	graph: CallGraph,
	roots: ReadonlyMap<number, string>,
	options: ReachOptions,
	registrations = registrationsByRegistrar(graph),
): Reached {
	const arrivals = new Map<number, Arrival>();
	const stoppedFrom = new Map<number, number>();
	const queue: number[] = [];
	for (const [id, reason] of roots) {
		if (options.stopAt.has(id) || arrivals.has(id)) continue;
		arrivals.set(id, { kind: "root", reason });
		queue.push(id);
	}
	const visit = (to: number, arrival: Arrival, from: number) => {
		if (arrivals.has(to)) return;
		if (options.stopAt.has(to)) {
			if (!stoppedFrom.has(to)) stoppedFrom.set(to, from);
			return;
		}
		arrivals.set(to, arrival);
		queue.push(to);
	};
	for (let head = 0; head < queue.length; head++) {
		const id = queue[head];
		const fn: GraphFunction = graph.functions[id];
		for (const [to, edge] of fn.edges) {
			if (options.skipEdge?.(id, to, edge)) continue;
			visit(to, { kind: "edge", from: id, edge }, id);
		}
		if (!options.followRegistrations) continue;
		for (const registration of registrations.get(id) ?? []) {
			for (const callback of registration.callbacks) {
				visit(callback, { kind: "registered", from: id, sink: registration.sink, line: registration.line }, id);
			}
		}
	}
	return { arrivals, stoppedFrom };
}

export function pathTo(reached: Reached, id: number): Array<{ readonly id: number; readonly arrival: Arrival }> {
	const chain: Array<{ readonly id: number; readonly arrival: Arrival }> = [];
	let current: number | undefined = id;
	const seen = new Set<number>();
	while (current !== undefined && !seen.has(current)) {
		seen.add(current);
		const arrival = reached.arrivals.get(current);
		if (arrival === undefined) break;
		chain.push({ id: current, arrival });
		current = arrival.kind === "root" ? undefined : arrival.from;
	}
	return chain.reverse();
}
