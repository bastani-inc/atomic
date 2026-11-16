export interface GraphRenderEdge {
	parentX: number;
	parentY: number;
	parentHeight: number;
	childX: number;
	childY: number;
	top: number;
	bottom: number;
	left: number;
	right: number;
}

interface EdgeBand {
	readonly top: number;
	readonly bottom: number;
	readonly maxBottom: number;
	readonly edges: GraphRenderEdge[];
	readonly maxRights: number[];
}

export interface GraphEdgeIndex {
	readonly bands: EdgeBand[];
}

function firstGreater(values: readonly number[], target: number): number {
	let low = 0;
	let high = values.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (values[middle]! <= target) low = middle + 1;
		else high = middle;
	}
	return low;
}

export function buildGraphEdgeIndex(edges: readonly GraphRenderEdge[]): GraphEdgeIndex {
	const groups = new Map<string, GraphRenderEdge[]>();
	for (const edge of edges) {
		const key = `${edge.top}:${edge.bottom}`;
		let group = groups.get(key);
		if (group === undefined) {
			group = [];
			groups.set(key, group);
		}
		group.push(edge);
	}
	let maxBottom = 0;
	const bands = [...groups.values()]
		.sort((a, b) => a[0]!.top - b[0]!.top)
		.map((group) => {
			const { top, bottom } = group[0]!;
			maxBottom = Math.max(maxBottom, bottom);
			group.sort((a, b) => a.left - b.left);
			let maxRight = 0;
			return {
				top,
				bottom,
				maxBottom,
				edges: group,
				maxRights: group.map((edge) => (maxRight = Math.max(maxRight, edge.right))),
			};
		});
	return { bands };
}

export function* visibleGraphEdges(
	index: GraphEdgeIndex,
	top: number,
	bottom: number,
	left: number,
	right: number,
): Generator<GraphRenderEdge> {
	const bands = index.bands;
	let low = 0;
	let high = bands.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (bands[middle]!.maxBottom <= top) low = middle + 1;
		else high = middle;
	}
	for (let bandIndex = low; bandIndex < bands.length && bands[bandIndex]!.top < bottom; bandIndex++) {
		const band = bands[bandIndex]!;
		if (band.bottom <= top) continue;
		for (let edgeIndex = firstGreater(band.maxRights, left); edgeIndex < band.edges.length; edgeIndex++) {
			const edge = band.edges[edgeIndex]!;
			if (edge.left >= right) break;
			if (edge.right > left) yield edge;
		}
	}
}
