#!/usr/bin/env python3
"""Per-phase table over both repetitions. Reads runs/<p>/rep{1,2} traces and summary.txt."""
import json, subprocess, sys, re
RP = "/fast/tmp/resume-perf"
rows = []
for p in ["ripgrep", "t3turbo", "fastapi", "atomic"]:
    summary = open(f"{RP}/runs/{p}/summary.txt").read().splitlines()
    for stage in ["cold", "warmstores", "warmlocal"]:
        lines = [l for l in summary if l.startswith(stage + " ")]
        for rep, line in enumerate(lines[:2], 1):
            s = re.search(r"start=(\d+)", line).group(1); f = re.search(r"firstRequest=(\d+)", line).group(1)
            d = json.loads(subprocess.check_output(["python3", f"{RP}/harness/analyze.py", f"{RP}/runs/{p}/rep{rep}/{stage}-trace2.json",
                "--start", s, "--first-request", f, "--blueprint-times", f"{RP}/runs/{p}/rep{rep}/{stage}-blueprint-times.txt"]))
            r = d["restores"][0]
            rows.append({"project": p, "stage": stage, "rep": rep, **{k: r[k] for k in ["fetch_ms", "reconstruct_ms", "materialize_ms", "lfs_ms", "verify_ms", "publish_ms", "restore_total_ms"]},
                         "blueprint_steps": [[x["log"].replace(".log", ""), x["ms"]] for x in d.get("blueprint_steps", [])],
                         "blueprint_total_ms": d.get("blueprint_total_ms", 0), "before_restore_ms": d.get("before_restore_ms"),
                         "other_ms": d["other_ms"], "time_to_first_prompt_ms": d["time_to_first_prompt_ms"]})
json.dump(rows, open(f"{RP}/results/resume-phases.json", "w"), indent=1)
print("| project | stage | rep | fetch | reconstruct | materialize | lfs | verify | restore total | blueprint steps | blueprint total | startup+other | time to first prompt |")
print("|---|---|---|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|")
for r in rows:
    import yaml
    bp = yaml.safe_load(open(f"{RP}/harness/projects/{r['project']}.yaml"))
    def label(n):
        parts = n.split("-"); sec, idx = parts[-2], int(parts[-1])
        return bp[sec][idx - 1]["name"]
    steps = "; ".join(f"{label(n)} {ms/1000:.1f}" for n, ms in r["blueprint_steps"])
    print(f"| {r['project']} | {r['stage']} | {r['rep']} | {r['fetch_ms']/1000:.2f} | {r['reconstruct_ms']/1000:.2f} | {r['materialize_ms']/1000:.2f} | {r['lfs_ms']/1000:.2f} | {r['verify_ms']/1000:.2f} | {r['restore_total_ms']/1000:.2f} | {steps} | {r['blueprint_total_ms']/1000:.1f} | {(r['other_ms'])/1000:.1f} | **{r['time_to_first_prompt_ms']/1000:.1f}** |")
