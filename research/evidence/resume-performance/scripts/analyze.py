#!/usr/bin/env python3
"""Turn a GIT_TRACE2_EVENT file (+ optional blueprint step times) into per-phase timings.
usage: analyze.py <trace2.json> [--capture] [--start MS --first-request MS --blueprint-times FILE]"""
import json, sys, datetime, argparse
ap = argparse.ArgumentParser(); ap.add_argument("trace"); ap.add_argument("--capture", action="store_true")
ap.add_argument("--start", type=int); ap.add_argument("--first-request", type=int); ap.add_argument("--blueprint-times")
ap.add_argument("--list", action="store_true")
a = ap.parse_args()
def ms(iso): return datetime.datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000
SKIP = ("-c",)
starts, cmds = {}, []
for line in open(a.trace):
    e = json.loads(line)
    if e["event"] == "start": starts[e["sid"]] = e
    elif e["event"] == "exit" and e["sid"] in starts:
        s = starts[e["sid"]]; argv = s["argv"][1:]
        clean, i = [], 0
        while i < len(argv):
            if argv[i] == "-c": i += 2; continue
            clean.append(argv[i]); i += 1
        # only top-level git processes (sid without '/'), children are part of their parent
        cmds.append({"t0": ms(s["time"]), "t1": ms(e["time"]), "argv": clean, "top": "/" not in e["sid"]})
cmds = [c for c in cmds if c["top"]]
cmds.sort(key=lambda c: c["t0"])
def is_(c, *words): return all(w in c["argv"] for w in words) if words else False
def first(pred, after=0, before=None):
    for i, c in enumerate(cmds):
        if i >= after and (before is None or i < before) and pred(c): return i
    return None
out = {}
if a.list:
    base = cmds[0]["t0"] if cmds else 0
    for c in cmds: print(f"{c['t0']-base:9.0f} {c['t1']-c['t0']:7.0f}  {' '.join(c['argv'])[:120]}")
if a.capture:
    caps = []
    i = 0
    while True:
        j = first(lambda c: c["argv"][:3] == ["rev-parse", "--git-path", "index"], i)
        if j is None: break
        k = first(lambda c: c["argv"][:1] == ["ls-files"] and ".gitattributes" in c["argv"], j)
        start = j - 1 if j > 0 and cmds[j-1]["argv"][:2] == ["rev-parse", "-q"] else j
        start = start - 1 if start > 0 and cmds[start-1]["argv"][:2] == ["rev-parse", "--show-toplevel"] else start
        end = k if k is not None else first(lambda c: c["argv"][:1] == ["write-tree"], j)
        unchanged = k is None
        caps.append({"ms": round(cmds[end]["t1"] - cmds[start]["t0"]), "git_processes": end - start + 1, "unchanged": unchanged,
                     "slowest": sorted(((round(c["t1"]-c["t0"]), " ".join(c["argv"])[:60]) for c in cmds[start:end+1]), reverse=True)[:3]})
        i = (k or j) + 1
    out["captures"] = caps
else:
    restores = []
    i = 0
    while True:
        add = first(lambda c: c["argv"][:2] == ["worktree", "add"], i)
        if add is None: break
        # fetch phase starts at init --bare or the first cat-file -e ^{commit} since the previous restore
        f0 = first(lambda c: (c["argv"][:1] == ["init"] and "--bare" in c["argv"]) or (c["argv"][:2] == ["cat-file", "-e"] and c["argv"][2].endswith("^{commit}")), i, add)
        # the store's refs are written by `update-ref refs/atomic/heads/...` (before #4732) or `update-ref --stdin` (after)
        ur = first(lambda c: c["argv"][:1] == ["update-ref"] and (c["argv"][1].startswith("refs/atomic/heads/") or c["argv"][1] == "--stdin"), i, add)
        ref = first(lambda c: c["argv"][:3] == ["update-index", "-q", "--refresh"], add)
        mv = first(lambda c: c["argv"][:2] == ["worktree", "move"], add)
        lst = first(lambda c: c["argv"][:2] == ["worktree", "list"], mv)
        fetches = [c for c in cmds[f0:ur+1] if c["argv"][:1] == ["fetch"]]
        vs = first(lambda c: c["argv"][:2] == ["rev-parse", "--show-toplevel"], ref + 1, mv)
        has_lfs = any(c["argv"][:1] == ["lfs"] for c in cmds[ref+1:vs])
        lfs_ms = round(cmds[vs-1]["t1"] - cmds[ref]["t1"]) if has_lfs else 0
        r = {"fetch_ms": round(cmds[ur]["t1"] - cmds[f0]["t0"]),
             "fetch_git_ms": round(sum(c["t1"]-c["t0"] for c in fetches)),
             "reconstruct_ms": round(cmds[add]["t0"] - cmds[ur]["t1"]),
             "materialize_ms": round(cmds[ref]["t1"] - cmds[add]["t0"]),
             "lfs_ms": lfs_ms,
             "verify_ms": round(cmds[mv]["t0"] - cmds[ref]["t1"]) - lfs_ms,
             "publish_ms": round(cmds[lst]["t1"] - cmds[mv]["t0"]),
             "restore_total_ms": round(cmds[lst]["t1"] - cmds[f0]["t0"]),
             "_t0": cmds[f0]["t0"], "_t1": cmds[lst]["t1"]}
        restores.append(r); i = lst + 1
    out["restores"] = restores
    if a.blueprint_times:
        steps = []
        for line in open(a.blueprint_times):
            n, b, m = line.split()
            b, m = float(b) * 1000, float(m) * 1000
            if a.start and m < a.start: continue
            steps.append({"log": n.rsplit("/", 1)[-1], "_b": b, "_t1": m})
        steps.sort(key=lambda s: s["_t1"])
        # birth time has second precision: a step starts when the previous one ended, the first no earlier than the restore end
        floor = max((r["_t1"] for r in restores), default=0)
        for i, st in enumerate(steps):
            st["_t0"] = steps[i-1]["_t1"] if i else max(st["_b"], floor)
            st["ms"] = round(st["_t1"] - st["_t0"])
        out["blueprint_steps"] = [{"log": s["log"].split("-", 3)[-1], "ms": s["ms"]} for s in steps]
        if steps: out["blueprint_total_ms"] = round(steps[-1]["_t1"] - steps[0]["_t0"])
    if a.start and a.first_request:
        out["time_to_first_prompt_ms"] = a.first_request - a.start
        if restores: out["before_restore_ms"] = round(restores[0]["_t0"] - a.start)
        rest = a.first_request - a.start - sum(r["restore_total_ms"] for r in restores) - out.get("blueprint_total_ms", 0)
        out["other_ms"] = round(rest)
    for r in restores: r.pop("_t0"); r.pop("_t1")
print(json.dumps(out, indent=1))
