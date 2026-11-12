/**
 * Low-rank completion of the benchmark table in `evals.md`.
 *
 * Benchmarks are strongly correlated, so a model's missing results can be
 * estimated from the results it has. Each benchmark (column) is standardized
 * to z-scores over the measured results, and the partially observed
 * (model, reasoning effort) × benchmark matrix is factored with regularized
 * alternating least squares. A row is one model at one effort; its factor is
 * `a + t·b`, where `t` is the effort's position on the reasoning scale and
 * `a`, `b` belong to the model, so every effort of a model, measured or not,
 * shares its evidence: rows the catalog never measured are interpolated from
 * the model's measured efforts and the effort trend of other models. The
 * benchmark factors, the residual variance and the spread of model factors
 * then define a Gaussian model: a model's factors have the empirical prior of
 * the catalog's models, and its own results update that prior by Bayesian
 * linear regression. The posterior gives every
 * result, measured or missing, a mean and a variance, so a model measured on
 * one benchmark carries more uncertainty than one measured on many, and one
 * outlying result moves the estimate only as far as the model's other results
 * support. Estimates stay within the range measured results span.
 *
 * Everything is deterministic: a fixed-seed initialization and a fixed number
 * of sweeps. A fit over the shipped catalog takes tens of milliseconds and runs
 * once per parsed catalog.
 */

/** Latent dimensions of the fit. Rank 3 predicts held-out results about as well as larger ranks. */
const RANK = 3;
/** Ridge penalty on factors during alternating least squares. */
const RIDGE = 1;
const SWEEPS = 60;
const SEED = 0x4689;
/** Floor on the residual variance, in squared z units, so in-sample fit never claims certainty. */
const MIN_RESIDUAL_VARIANCE = 0.05;

type Vector = number[];
type Matrix = number[][];

/** Deterministic standard normal draws (mulberry32 with Box-Muller). */
function normalSource(seed: number): () => number {
	let state = seed >>> 0;
	const uniform = () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	return () => Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(2 * Math.PI * uniform());
}

const zeros = (size: number): Vector => new Array<number>(size).fill(0);
const identity = (size: number, scale = 1): Matrix =>
	Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, col) => (row === col ? scale : 0)));
const dot = (a: readonly number[], b: readonly number[]) => a.reduce((sum, value, index) => sum + value * b[index]!, 0);

/** Solve `A x = b` for a small symmetric positive-definite `A` by Gaussian elimination with partial pivoting. */
function solve(matrix: Matrix, rhs: Vector): Vector {
	const size = rhs.length;
	const a = matrix.map((row, index) => [...row, rhs[index]!]);
	for (let col = 0; col < size; col++) {
		let pivot = col;
		for (let row = col + 1; row < size; row++) if (Math.abs(a[row]![col]!) > Math.abs(a[pivot]![col]!)) pivot = row;
		[a[col], a[pivot]] = [a[pivot]!, a[col]!];
		const lead = a[col]![col]!;
		for (let row = 0; row < size; row++) {
			if (row === col) continue;
			const factor = a[row]![col]! / lead;
			for (let k = col; k <= size; k++) a[row]![k]! -= factor * a[col]![k]!;
		}
	}
	return a.map((row, index) => row[size]! / row[index]!);
}

const inverse = (matrix: Matrix): Matrix => {
	const columns = identity(matrix.length).map((unit) => solve(matrix, unit));
	return matrix.map((_, row) => columns.map((column) => column[row]!));
};

/** `Σ_k x_k x_kᵀ + diag`, the normal-equation matrix of a ridge regression. */
function gram(vectors: readonly Vector[], diagonal: Matrix): Matrix {
	const result = diagonal.map((row) => [...row]);
	for (const vector of vectors)
		for (let i = 0; i < vector.length; i++)
			for (let j = 0; j < vector.length; j++) result[i]![j]! += vector[i]! * vector[j]!;
	return result;
}

function ridgeFit(features: readonly Vector[], targets: readonly number[], size: number): Vector {
	const rhs = zeros(size);
	features.forEach((feature, index) => {
		for (let k = 0; k < size; k++) rhs[k]! += feature[k]! * targets[index]!;
	});
	return solve(gram(features, identity(size, RIDGE)), rhs);
}

/** One result a model has for a benchmark. */
export interface Observation {
	readonly key: string;
	readonly value: number;
	/** Position of the result's reasoning effort on the effort scale. */
	readonly effort: number;
	/** Multiple of the residual variance this result carries; 1, the default, is a direct measurement. */
	readonly noise?: number;
}

/** A model's estimated result on one benchmark, in the benchmark's own unit. */
export interface EstimatedResult {
	readonly key: string;
	readonly value: number;
	/** Standard error of `value`, in the benchmark's own unit. */
	readonly error: number;
}

/** A model's estimated quality for one weighting of benchmarks. */
export interface QualityEstimate {
	/** Weighted mean z-score over the weighted benchmarks at the requested effort. */
	readonly mean: number;
	/** Standard error of `mean`. */
	readonly error: number;
	/** Weighted benchmarks the model has a direct result for at the requested effort. */
	readonly measured: readonly string[];
	/** Weighted benchmarks the model lacks at the requested effort, with the completion's estimate. */
	readonly estimated: readonly EstimatedResult[];
}

/** The fitted completion for one catalog. */
export interface BenchmarkCompletion {
	/** Benchmarks with enough results to take part in the fit. */
	readonly keys: ReadonlySet<string>;
	/**
	 * Estimate quality at `effort` from a model's own results under
	 * per-benchmark `weights`. An observation with `noise` above 1, such as a
	 * result reported under another harness, carries that many times the
	 * residual variance and is not counted as measured.
	 */
	estimate(
		observations: readonly Observation[],
		weights: ReadonlyMap<string, number>,
		effort: number,
	): QualityEstimate | undefined;
}

interface Entry {
	readonly column: number;
	readonly z: number;
	readonly effort: number;
	readonly noise: number;
}

/** Regression features of one entry for a model's factors `[a, b]`: the benchmark loading, and it scaled by effort. */
const features = (loading: Vector, effort: number): Vector => [...loading, ...loading.map((x) => x * effort)];

/**
 * Fit the completion to each catalog model's direct results. Benchmarks
 * measured on fewer than `minModels` models, or without spread, are left out.
 */
export function completeBenchmarks(
	models: ReadonlyMap<string, readonly Observation[]>,
	minModels: number,
): BenchmarkCompletion {
	const byKey = new Map<string, { values: number[]; models: Set<string> }>();
	for (const [model, observations] of models)
		for (const { key, value } of observations) {
			const entry = byKey.get(key) ?? { values: [], models: new Set<string>() };
			entry.values.push(value);
			entry.models.add(model);
			byKey.set(key, entry);
		}
	const keys: string[] = [];
	const center: number[] = [];
	const scale: number[] = [];
	const low: number[] = [];
	const high: number[] = [];
	for (const [key, { values, models: measured }] of byKey) {
		if (measured.size < minModels) continue;
		const mean = values.reduce((a, b) => a + b, 0) / values.length;
		const sd = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
		if (!(sd > 0)) continue;
		keys.push(key);
		center.push(mean);
		scale.push(sd);
		low.push((Math.min(...values) - mean) / sd);
		high.push((Math.max(...values) - mean) / sd);
	}
	const column = new Map(keys.map((key, index) => [key, index]));
	const z = (key: string, value: number) => {
		const index = column.get(key)!;
		return (value - center[index]!) / scale[index]!;
	};
	const toEntries = (observations: readonly Observation[]): Entry[] =>
		observations
			.filter((observation) => column.has(observation.key))
			.map((observation) => ({
				column: column.get(observation.key)!,
				z: z(observation.key, observation.value),
				effort: observation.effort,
				noise: observation.noise ?? 1,
			}));
	const rows = [...models.values()].map(toEntries).filter((entries) => entries.length > 0);
	const byColumn: { row: number; entry: Entry }[][] = keys.map(() => []);
	rows.forEach((entries, row) => {
		for (const entry of entries) byColumn[entry.column]!.push({ row, entry });
	});

	const size = 2 * RANK;
	const draw = normalSource(SEED);
	const u: Matrix = rows.map(() => Array.from({ length: size }, () => 0.1 * draw()));
	const v: Matrix = keys.map(() => Array.from({ length: RANK }, () => 0.1 * draw()));
	/** A model's factor at one effort: `a + t·b`. */
	const at = (factors: Vector, effort: number) =>
		Array.from({ length: RANK }, (_, k) => factors[k]! + effort * factors[RANK + k]!);
	for (let sweep = 0; sweep < SWEEPS && keys.length > 0; sweep++) {
		rows.forEach((entries, row) => {
			u[row] = ridgeFit(
				entries.map((entry) => features(v[entry.column]!, entry.effort)),
				entries.map((entry) => entry.z),
				size,
			);
		});
		byColumn.forEach((entries, col) => {
			v[col] = ridgeFit(
				entries.map(({ row, entry }) => at(u[row]!, entry.effort)),
				entries.map(({ entry }) => entry.z),
				RANK,
			);
		});
	}

	// Empirical prior of a model's factors: the mean and covariance of the fitted model factors.
	const priorMean = zeros(size);
	for (const factor of u) for (let k = 0; k < size; k++) priorMean[k]! += factor[k]! / Math.max(1, u.length);
	const priorCovariance = identity(size, 1e-6);
	for (const factor of u)
		for (let i = 0; i < size; i++)
			for (let j = 0; j < size; j++)
				priorCovariance[i]![j]! +=
					((factor[i]! - priorMean[i]!) * (factor[j]! - priorMean[j]!)) / Math.max(1, u.length - 1);
	const priorPrecision = inverse(priorCovariance);
	const priorShift = priorPrecision.map((row) => dot(row, priorMean));

	/** Posterior mean and covariance of a model's factors given its standardized results. */
	const posterior = (entries: readonly Entry[], residual: number) => {
		const precision = gram(
			entries.map((entry) =>
				features(v[entry.column]!, entry.effort).map((x) => x / Math.sqrt(residual * entry.noise)),
			),
			priorPrecision,
		);
		const shift = [...priorShift];
		for (const entry of entries) {
			const feature = features(v[entry.column]!, entry.effort);
			for (let k = 0; k < size; k++) shift[k]! += (feature[k]! * entry.z) / (residual * entry.noise);
		}
		const covariance = inverse(precision);
		return { factor: covariance.map((row) => dot(row, shift)), covariance };
	};
	const quadratic = (covariance: Matrix, vector: Vector) =>
		dot(
			vector,
			covariance.map((row) => dot(row, vector)),
		);

	// Residual variance from leave-one-out predictions, which unlike the in-sample
	// fit do not reward a model for matching the result it was fitted to. Each
	// left-out residual is the in-sample one inflated by the result's leverage.
	let residual = 1;
	for (let pass = 0; pass < 3 && keys.length > 0; pass++) {
		let squared = 0;
		let count = 0;
		for (const entries of rows) {
			const { factor, covariance } = posterior(entries, residual);
			for (const entry of entries) {
				const feature = features(v[entry.column]!, entry.effort);
				const leverage = Math.min(0.99, quadratic(covariance, feature) / residual);
				squared += ((entry.z - dot(factor, feature)) / (1 - leverage)) ** 2;
				count++;
			}
		}
		residual = Math.max(MIN_RESIDUAL_VARIANCE, count ? squared / count : 1);
	}

	return {
		keys: new Set(keys),
		estimate(observations, weights, effort) {
			const weighted = [...weights].filter(([key, weight]) => weight > 0 && column.has(key));
			const total = weighted.reduce((sum, [, weight]) => sum + weight, 0);
			if (total === 0) return undefined;
			const entries = toEntries(observations);
			const { factor, covariance } = posterior(entries, residual);
			const direct = new Set(
				entries.filter((entry) => entry.noise === 1 && entry.effort === effort).map((entry) => keys[entry.column]!),
			);
			// Quality is the model's inferred ability on each weighted benchmark at
			// this effort: a measured result is weighed with everything else the
			// model scored, so one outlying result moves the estimate only as far as
			// the rest supports. Estimates stay within the range measured results span.
			let sum = 0;
			let missingNoise = 0;
			const direction = zeros(size);
			const measured: string[] = [];
			const estimated: EstimatedResult[] = [];
			for (const [key, weight] of weighted) {
				const index = column.get(key)!;
				const feature = features(v[index]!, effort);
				const ability = Math.min(high[index]!, Math.max(low[index]!, dot(factor, feature)));
				sum += weight * ability;
				for (let k = 0; k < size; k++) direction[k]! += weight * feature[k]!;
				if (direct.has(key)) {
					measured.push(key);
					continue;
				}
				// A result nobody measured also varies from the model's ability by the residual.
				missingNoise += weight * weight * residual;
				estimated.push({
					key,
					value: center[index]! + ability * scale[index]!,
					error: Math.sqrt(quadratic(covariance, feature) + residual) * scale[index]!,
				});
			}
			const variance = quadratic(covariance, direction) + missingNoise;
			return { mean: sum / total, error: Math.sqrt(variance) / total, measured, estimated };
		},
	};
}
