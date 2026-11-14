const { captureWorktreeSnapshot } = await import(`${process.env.ATOMIC_REPO ?? "/fast/github_work/atomic-wt/resume-perf"}/packages/coding-agent/dist/core/worktree-snapshot/index.js`);
const s = performance.now(); const c = await captureWorktreeSnapshot(process.argv[2]);
const snap = c.snapshot;
console.log(JSON.stringify({ ms: Math.round(performance.now() - s), status: c.status, remotes: snap?.remotes, bundle: snap?.bundle ? { bytes: snap.bundle.bytes, commits: snap.bundle.commits.length } : null, omitted: Object.entries((snap?.omitted ?? []).reduce((a, o) => ({ ...a, [o.reason]: (a[o.reason] ?? 0) + 1 }), {})) }));
