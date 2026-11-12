/**
 * Low-rank completion of the benchmark table in `evals.md`.
 *
 * Benchmarks are strongly correlated, so a model's missing results can be
 * estimated from the results it has. Each benchmark (column) is standardized
 * to z-scores over the models measured on it, and the partially observed
 * model × benchmark matrix is factored as `Z ≈ U Vᵀ` with regularized
 * alternating least squares. The benchmark factors `V`, the residual variance
 * and the spread of model factors then define a Gaussian model: a model's
 * factor has the empirical prior of the catalog's models, and its own results
 * update that prior by Bayesian linear regression. The posterior gives every
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
/** A result reported under another harness counts as this many times noisier than a fitted measurement. */
const REPORTED_NOISE = 2;
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

function ridgeFit(factors: readonly Vector[], targets: readonly number[]): Vector {
	const rhs = zeros(RANK);
	factors.forEach((factor, index) => {
		for (let k = 0; k < RANK; k++) rhs[k]! += factor[k]! * targets[index]!;
	});
	return solve(gram(factors, identity(RANK, RIDGE)), rhs);
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
	/** Weighted mean z-score over the weighted benchmarks, measured where available and estimated elsewhere. */
	readonly mean: number;
	/** Standard error of `mean`; zero when every weighted benchmark is measured. */
	readonly error: number;
	/** Weighted benchmarks the model has a result for. */
	readonly measured: readonly string[];
	/** Weighted benchmarks the model lacks, with the completion's estimate. */
	readonly estimated: readonly EstimatedResult[];
}

/** The fitted completion for one catalog. */
export interface BenchmarkCompletion {
	/** Benchmarks with enough results to take part in the fit. */
	readonly keys: ReadonlySet<string>;
	/**
	 * Estimate quality from a model's own results under per-benchmark `weights`.
	 * `reported` holds results published for a fitted benchmark under another
	 * harness; they inform the estimate as noisier observations but are not
	 * counted as measured.
	 */
	estimate(
		values: ReadonlyMap<string, number>,
		weights: ReadonlyMap<string, number>,
		reported?: ReadonlyMap<string, number>,
	): QualityEstimate | undefined;
}

/**
 * Fit the completion to `cohorts`: per benchmark key, each catalog model's
 * result. Benchmarks measured on fewer than `minModels` models, or without
 * spread, are left out.
 */
export function completeBenchmarks(
	cohorts: ReadonlyMap<string, ReadonlyMap<string, number>>,
	minModels: number,
): BenchmarkCompletion {
	const keys: string[] = [];
	const center: number[] = [];
	const scale: number[] = [];
	for (const [key, cohort] of cohorts) {
		if (cohort.size < minModels) continue;
		const values = [...cohort.values()];
		const mean = values.reduce((a, b) => a + b, 0) / values.length;
		const sd = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
		if (!(sd > 0)) continue;
		keys.push(key);
		center.push(mean);
		scale.push(sd);
	}
	const column = new Map(keys.map((key, index) => [key, index]));
	const low = keys.map((key, index) => (Math.min(...cohorts.get(key)!.values()) - center[index]!) / scale[index]!);
	const high = keys.map((key, index) => (Math.max(...cohorts.get(key)!.values()) - center[index]!) / scale[index]!);
	const identities = new Map<string, Map<string, number>>();
	for (const key of keys)
		for (const [identity, value] of cohorts.get(key)!) {
			const row = identities.get(identity) ?? new Map<string, number>();
			row.set(key, value);
			identities.set(identity, row);
		}
	const z = (key: string, value: number) => {
		const index = column.get(key)!;
		return (value - center[index]!) / scale[index]!;
	};
	const rows = [...identities.values()].map((row) =>
		[...row].map(([key, value]) => ({ column: column.get(key)!, z: z(key, value) })),
	);
	const byColumn: { row: number; z: number }[][] = keys.map(() => []);
	rows.forEach((entries, row) => {
		for (const entry of entries) byColumn[entry.column]!.push({ row, z: entry.z });
	});

	const draw = normalSource(SEED);
	const u: Matrix = rows.map(() => Array.from({ length: RANK }, () => 0.1 * draw()));
	const v: Matrix = keys.map(() => Array.from({ length: RANK }, () => 0.1 * draw()));
	for (let sweep = 0; sweep < SWEEPS && keys.length > 0; sweep++) {
		rows.forEach((entries, row) => {
			u[row] = ridgeFit(
				entries.map((entry) => v[entry.column]!),
				entries.map((entry) => entry.z),
			);
		});
		byColumn.forEach((entries, col) => {
			v[col] = ridgeFit(
				entries.map((entry) => u[entry.row]!),
				entries.map((entry) => entry.z),
			);
		});
	}

	// Empirical prior of a model's factor: the mean and covariance of the fitted model factors.
	const priorMean = zeros(RANK);
	for (const factor of u) for (let k = 0; k < RANK; k++) priorMean[k]! += factor[k]! / Math.max(1, u.length);
	const priorCovariance = identity(RANK, 1e-6);
	for (const factor of u)
		for (let i = 0; i < RANK; i++)
			for (let j = 0; j < RANK; j++)
				priorCovariance[i]![j]! +=
					((factor[i]! - priorMean[i]!) * (factor[j]! - priorMean[j]!)) / Math.max(1, u.length - 1);
	const priorPrecision = inverse(priorCovariance);
	const priorShift = priorPrecision.map((row) => dot(row, priorMean));

	/** Posterior mean and covariance of a model's factor given its standardized results. */
	const posterior = (entries: readonly { column: number; z: number; noise?: number }[], residual: number) => {
		const precision = gram(
			entries.map((entry) => v[entry.column]!.map((x) => x / Math.sqrt(residual * (entry.noise ?? 1)))),
			priorPrecision,
		);
		const shift = [...priorShift];
		for (const entry of entries)
			for (let k = 0; k < RANK; k++) shift[k]! += (v[entry.column]![k]! * entry.z) / (residual * (entry.noise ?? 1));
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
				const loading = v[entry.column]!;
				const leverage = Math.min(0.99, quadratic(covariance, loading) / residual);
				squared += ((entry.z - dot(factor, loading)) / (1 - leverage)) ** 2;
				count++;
			}
		}
		residual = Math.max(MIN_RESIDUAL_VARIANCE, count ? squared / count : 1);
	}

	return {
		keys: new Set(keys),
		estimate(values, weights, reported = new Map()) {
			const weighted = [...weights].filter(([key, weight]) => weight > 0 && column.has(key));
			const total = weighted.reduce((sum, [, weight]) => sum + weight, 0);
			if (total === 0) return undefined;
			const { factor, covariance } = posterior(
				[
					...[...values]
						.filter(([key]) => column.has(key))
						.map(([key, value]) => ({ column: column.get(key)!, z: z(key, value) })),
					...[...reported]
						.filter(([key]) => column.has(key))
						.map(([key, value]) => ({ column: column.get(key)!, z: z(key, value), noise: REPORTED_NOISE })),
				],
				residual,
			);
			// Quality is the model's inferred ability on each weighted benchmark: a
			// measured result is weighed with everything else the model scored, so one
			// outlying result moves the estimate only as far as the rest supports.
			// Estimates stay within the range measured results span.
			let sum = 0;
			let missingNoise = 0;
			const direction = zeros(RANK);
			const measured: string[] = [];
			const estimated: EstimatedResult[] = [];
			for (const [key, weight] of weighted) {
				const index = column.get(key)!;
				const loading = v[index]!;
				const ability = Math.min(high[index]!, Math.max(low[index]!, dot(factor, loading)));
				sum += weight * ability;
				for (let k = 0; k < RANK; k++) direction[k]! += weight * loading[k]!;
				if (values.has(key)) {
					measured.push(key);
					continue;
				}
				// A result nobody measured also varies from the model's ability by the residual.
				missingNoise += weight * weight * residual;
				estimated.push({
					key,
					value: center[index]! + ability * scale[index]!,
					error: Math.sqrt(quadratic(covariance, loading) + residual) * scale[index]!,
				});
			}
			const variance = quadratic(covariance, direction) + missingNoise;
			return { mean: sum / total, error: Math.sqrt(variance) / total, measured, estimated };
		},
	};
}
