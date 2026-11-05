import v8 from "node:v8";
import vm from "node:vm";

v8.setFlagsFromString("--expose-gc");
const collect = vm.runInNewContext("gc") as () => void;

export async function collectGarbage(rounds = 10): Promise<void> {
	for (let round = 0; round < rounds; round++) {
		collect();
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

export interface CollectionCount {
	readonly created: number;
	collected(): number;
	uncollected(): number[];
	track(target: object): void;
}

export function trackCollection(): CollectionCount {
	let created = 0;
	const collectedIndexes = new Set<number>();
	const registry = new FinalizationRegistry<number>((index) => {
		collectedIndexes.add(index);
	});
	return {
		get created() {
			return created;
		},
		collected: () => collectedIndexes.size,
		uncollected: () =>
			Array.from({ length: created }, (_, index) => index + 1).filter((index) => !collectedIndexes.has(index)),
		track(target) {
			created += 1;
			registry.register(target, created);
		},
	};
}
