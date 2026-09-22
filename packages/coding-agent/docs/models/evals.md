---
title: "Evals"
description: "Primary-source benchmark facts used by Atomic automatic model routing."
---

# Evals

Last Accessed: 2026-09-22.

Key:

- `∅`=source null/absent, not zero.
- Values are rounded to 1 decimal from the [model leaderboard](https://artificialanalysis.ai/leaderboards/models) payload, Coding Index and Agentic Index fields on free `GET /api/v2/language/models/free`, and default-chart constituent fields on the [Intelligence Index](https://artificialanalysis.ai/evaluations/artificial-analysis-intelligence-index) page.
- A chart label may show the nearest integer of `idx`.
- `idx`: Intelligence Index points.
- `Cod`: Coding Index points.
- `Agt`: Agentic Index points.
- `Brief`: AA-Briefcase normalized Elo `clamp((Elo-500)/2000)*100`.
- `Gn`: GDPval-AA normalized Elo `clamp((Elo-500)/2000)*100`.
- `Omni`: Omniscience Index, -100 to 100.
- `Open`: Openness Index points.
- Other score columns are percent.
- `OA`: Omniscience accuracy.
- `ONH`: the 6,000-question ONH rate `(partial+notattempted)/(incorrect+partial+notattempted)`, not 1 minus the hallucination rate.
- `PDF`: GDP.pdf All-pass.
- `Auto`: AutomationBench-AA.
- `TB4`: Terminal-Bench 4.0.
- `TB21`: Terminal-Bench 2.1.
- `TBh`: Terminal-Bench Hard.
- `Sci`: SciCode.
- `HLE`: Humanity's Last Exam.
- `Crit`: CritPt.
- `LCR`: AA-LCR.
- `GPQA`: GPQA Diamond.
- `IF`: IFBench.
- `MMMU`: MMMU-Pro.
- `tau2`: τ².
- `tauB`: τ²-Banking.
- `Analyst`: Analyst Agent.
- `ITB`: ITBench SRE.
- `Apex`: Apex Agents.
- `AIME`: AIME 2025.
- `LCB`: LiveCodeBench.
- `Harvey`: Harvey Lab.
- `MLCR`: MLCR overall.
- `Ent`: EnterpriseOps Gym.
- `Brief`, `Auto`, `PDF`, `AIME`, `LCB`, `Harvey`, `MLCR`, `Open`, and `Ent` are published for default-chart models; other rows are `∅` for those columns.

## Artificial Analysis Intelligence Index v4.3.2

Table: top 26 catalog models by Intelligence Index, plus GPT-6 Luna (max) from below that cutoff. Fifty does not fit. Jev allows 32k tokens for state plus the longest question, and this snapshot is sent in full with the model-selection guide.

| slug | Model | idx | Brief | Gn | Auto | TB4 | Sci | HLE | PDF | Crit | OA | ONH | LCR | Cod | Agt | Omni | GPQA | TB21 | TBh | IF | MMMU | tau2 | tauB | Analyst | ITB | Apex | AIME | LCB | Harvey | MLCR | Open | Ent |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| claude-opus-5-5 | Claude Opus 5.5 (Adaptive Reasoning, Max Effort, Default Fallback) | 57.6 | 66.1 | 67.3 | 69.5 | 59.6 | 66.9 | 61.4 | 26.2 | 31.7 | 66.2 | 41.4 | 84.7 | ∅ | ∅ | 46.4 | ∅ | ∅ | ∅ | ∅ | 87.7 | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | 91.2 | ∅ | ∅ | ∅ |
| claude-opus-5-5-xhigh | Claude Opus 5.5 (Adaptive Reasoning, Xhigh Effort, Default Fallback) | 56 | 64 | 66 | 65 | 59.6 | 65 | 57.5 | 26.6 | 31.7 | 65.4 | 34.3 | 84.7 | ∅ | ∅ | 42.7 | ∅ | ∅ | ∅ | ∅ | 86.6 | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | 91.2 | ∅ | ∅ | ∅ |
| claude-opus-5-5-high | Claude Opus 5.5 (Adaptive Reasoning, High Effort, Default Fallback) | 53.6 | 60.2 | 59.6 | 63.2 | 56.6 | 60.4 | 55.6 | 28.8 | 30.9 | 64.6 | 32.4 | 82.7 | ∅ | ∅ | 40.6 | ∅ | ∅ | ∅ | ∅ | 85.8 | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | 90.9 | ∅ | ∅ | ∅ |
| claude-fable-5-1 | Claude Fable 5.1 (Adaptive Reasoning, Max Effort, Default Fallback) | 53.4 | 58.9 | 61.7 | 59.4 | 52 | 63.1 | 59.1 | 26.2 | 29.7 | 67.2 | 27.4 | 85.3 | 81.6 | 57.9 | 43.5 | 93.7 | 91.4 | ∅ | ∅ | ∅ | ∅ | 47.2 | 57.5 | ∅ | ∅ | ∅ | ∅ | 93 | 71.1 | ∅ | ∅ |
| claude-fable-5-1-xhigh | Claude Fable 5.1 (Adaptive Reasoning, Xhigh Effort, Default Fallback) | 53.2 | 58.4 | 61 | 57.8 | 55.1 | 60.9 | 58.7 | 26.2 | 31.1 | 66.2 | 29.5 | 83 | 80.7 | 57.2 | 42.4 | 93.4 | 91 | ∅ | ∅ | ∅ | ∅ | 45.8 | ∅ | ∅ | ∅ | ∅ | ∅ | 93.3 | ∅ | ∅ | ∅ |
| gpt-6-astra | GPT-6 Astra (max) | 52.7 | 53.4 | 52.1 | 68.5 | 59.1 | 56.5 | 54.7 | 31 | 31.7 | 62.6 | 48.7 | 80.7 | 76.9 | 51 | 43.4 | 96.1 | 88.4 | ∅ | ∅ | 86.9 | ∅ | 41.4 | 51.3 | ∅ | ∅ | ∅ | ∅ | ∅ | 35 | ∅ | ∅ |
| gpt-6-astra-xhigh | GPT-6 Astra (xhigh) | 52.4 | 52.2 | 50.8 | 67.2 | 59.6 | 55.7 | 54.6 | 32.2 | 31.4 | 61.9 | 51.7 | 80 | 75.9 | 50.2 | 43.4 | 96.3 | 89.1 | ∅ | ∅ | 86.2 | ∅ | 43.1 | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ |
| claude-fable-5-1-high | Claude Fable 5.1 (Adaptive Reasoning, High Effort, Default Fallback) | 51.2 | 54.6 | 55.9 | 55.3 | 52 | 58.7 | 55.9 | 26.8 | 30.3 | 64.9 | 31.2 | 83.7 | 79.1 | 53.1 | 40.8 | 90.6 | 89.9 | ∅ | ∅ | ∅ | ∅ | 43.1 | ∅ | ∅ | ∅ | ∅ | ∅ | 93 | ∅ | ∅ | ∅ |
| claude-opus-5-5-medium | Claude Opus 5.5 (Adaptive Reasoning, Medium Effort, Default Fallback) | 51.2 | 57.1 | 53.8 | 61.2 | 52.5 | 59.3 | 54.7 | 25.6 | 27.7 | 64.6 | 31.6 | 84.3 | ∅ | ∅ | 40.3 | ∅ | ∅ | ∅ | ∅ | 85.7 | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | 90.3 | ∅ | ∅ | ∅ |
| gpt-6-astra-high | GPT-6 Astra (high) | 50.9 | 50.3 | 49.2 | 66.6 | 54 | 55.4 | 53.1 | 31 | 28.9 | 61.1 | 55.2 | 80 | 77.1 | 48.2 | 43.7 | 94.9 | 89.9 | ∅ | ∅ | 86.4 | ∅ | 40 | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ |
| claude-opus-5 | Claude Opus 5 (Adaptive Reasoning, Max Effort) | 50.8 | 58.7 | 60.4 | 56.6 | 49 | 56.4 | 54.9 | 21.6 | 29.1 | 60.9 | 39.2 | 79.3 | 78 | 56.5 | 37.1 | 93.2 | 89.1 | ∅ | ∅ | 84.7 | ∅ | 42.1 | 53.8 | ∅ | ∅ | ∅ | ∅ | 93.5 | 55.6 | ∅ | 47.5 |
| claude-opus-5-xhigh | Claude Opus 5 (Adaptive Reasoning, Xhigh Effort) | 49.7 | 57.5 | 58.8 | 53.2 | 46.5 | 55.7 | 54.4 | 21 | 27.7 | 59.5 | 40.5 | 80.3 | 77 | 55.6 | 35.4 | 93.7 | 88 | ∅ | ∅ | 84 | ∅ | 43.3 | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | 58.3 | ∅ | ∅ |
| claude-fable-5 | Claude Fable 5 (Adaptive Reasoning, Max Effort, Opus 4.8 Fallback) | 49.6 | ∅ | 54.8 | 54.1 | 42.4 | 61 | 55.5 | 24 | 28.6 | 65.4 | 36.4 | 82.3 | 76.5 | 50.7 | 43.3 | 92.6 | 84.6 | 62.9 | 63.5 | ∅ | 98.5 | 38.1 | 48.8 | ∅ | ∅ | ∅ | ∅ | 93.6 | 64.4 | ∅ | 51.1 |
| gpt-6-astra-medium | GPT-6 Astra (medium) | 49.6 | ∅ | 48.4 | 64.6 | 49.5 | 54.2 | 52.7 | 30.4 | 29.1 | 60.6 | 53.5 | 79.7 | 76.7 | 46 | 42.2 | 93.9 | 89.5 | ∅ | ∅ | 85.1 | ∅ | 35.5 | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ |
| claude-fable-5-1-medium | Claude Fable 5.1 (Adaptive Reasoning, Medium Effort, Default Fallback) | 48.9 | ∅ | 51.8 | 54.7 | 44.9 | 56.4 | 53.8 | 26.8 | 29.1 | 63.1 | 30.9 | 84.7 | 77.1 | 50.2 | 37.6 | 88.6 | 88 | ∅ | ∅ | ∅ | ∅ | 41 | ∅ | ∅ | ∅ | ∅ | ∅ | 92.6 | ∅ | ∅ | ∅ |
| claude-opus-5-high | Claude Opus 5 (Adaptive Reasoning, High Effort) | 48.1 | ∅ | 54.1 | 53.6 | 46 | 55.4 | 52.8 | 19.6 | 28.3 | 58.9 | 38.8 | 79 | 76.5 | 52.3 | 33.7 | 93.7 | 87.6 | ∅ | ∅ | 82.4 | ∅ | 44.7 | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | 59.4 | ∅ | ∅ |
| muse-spark-1-3 | Muse Spark 1.3 (max) | 48.1 | 54.9 | 58.7 | 57.9 | 33.3 | 58.8 | 48.7 | 26.6 | 24.9 | 43.6 | 67.1 | 83 | 75.8 | 55.5 | 25 | 93.5 | 84.3 | ∅ | ∅ | ∅ | ∅ | 50.5 | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | 43.3 | ∅ | ∅ |
| gpt-6-sol | GPT-6 Sol (max) | 47.5 | ∅ | 49.3 | ∅ | 43.9 | 57.6 | 47.9 | ∅ | 30.9 | 54.5 | 39.9 | 83.7 | ∅ | ∅ | 27.1 | ∅ | ∅ | ∅ | ∅ | 83.3 | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ |
| gpt-5-6-sol | GPT-5.6 Sol (max) | 47 | 49.4 | 54.4 | 60.1 | 39.9 | 57.1 | 49.5 | 27.2 | 32.3 | 59.4 | 7.8 | 84 | 77.4 | 50.2 | 22 | 94.1 | 88 | 65.9 | 72.7 | 83.4 | 85.1 | 44.3 | 47.5 | 56.2 | ∅ | ∅ | ∅ | 87.2 | 26.1 | ∅ | 42.9 |
| claude-fable-5-1-low | Claude Fable 5.1 (Adaptive Reasoning, Low Effort, Default Fallback) | 46.8 | ∅ | 47.5 | 52.2 | 40.4 | 56.7 | 48.9 | 28 | 27.7 | 60.2 | 34.4 | 82.3 | 75.2 | 47.1 | 34.1 | 88.1 | 85 | ∅ | ∅ | ∅ | ∅ | 39 | ∅ | ∅ | ∅ | ∅ | ∅ | 92.3 | ∅ | ∅ | ∅ |
| grok-4-7 | Grok 4.7 (xhigh) | 46.4 | 57.9 | 59.8 | 65.6 | 25.8 | 57.4 | 43.1 | 20 | 17.7 | 47.5 | 70.7 | 76.7 | ∅ | ∅ | 32 | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | 15 | ∅ | ∅ |
| grok-4-7-high | Grok 4.7 (high) | 46.3 | 57.2 | 59.7 | 63.5 | 24.7 | 57.8 | 42.3 | 23.2 | 18 | 47.8 | 67.6 | 77 | ∅ | ∅ | 30.9 | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ |
| mimo-v2-6-pro | MiMo-V2.6-Pro | 46.3 | 51.1 | 58.7 | 58.6 | 34.8 | 60.9 | 49.4 | 19.2 | 26.6 | 34.9 | 59.4 | 86.3 | ∅ | ∅ | 8.4 | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ |
| gpt-6-astra-low | GPT-6 Astra (low) | 45.8 | ∅ | 43.3 | 59.1 | 41.9 | 54.1 | 49.2 | 30.4 | 26.3 | 59.5 | 53.1 | 80 | 75.7 | 38.8 | 40.6 | 93.1 | 88 | ∅ | ∅ | 84.6 | ∅ | 32 | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ |
| qwen3-8-max | Qwen3.8 Max (0902) | 45.4 | 57 | 58.4 | 56.2 | 38.9 | 52.1 | 43.1 | 22.8 | 17.7 | 31.7 | 71.2 | 80.3 | 76.2 | 56 | 12 | 92.8 | 88.8 | ∅ | ∅ | 82.8 | ∅ | 47.8 | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | 20 | ∅ | ∅ |
| muse-spark-1-3-xhigh | Muse Spark 1.3 (xhigh) | 45.1 | ∅ | 56.4 | 56.8 | 16.7 | 59.7 | 47.5 | 24.2 | 26 | 41.5 | 68.5 | 83 | 76.5 | 51.5 | 23.1 | 94.1 | 85.4 | ∅ | ∅ | 82 | ∅ | 47.2 | ∅ | ∅ | ∅ | ∅ | ∅ | 95.5 | ∅ | ∅ | ∅ |
| gpt-6-luna | GPT-6 Luna (max) | 37.3 | ∅ | 43.4 | ∅ | 12.6 | 54.6 | 38.5 | ∅ | 19.4 | 43.8 | 23.3 | 83.3 | ∅ | ∅ | 0.7 | ∅ | ∅ | ∅ | ∅ | 75.5 | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ |

## Cognition FrontierCode 1.1

[FrontierCode](https://cognition.com/frontiercode) 1.1 (revision 2026-07-07; [data](https://cognition.com/data/frontiercode-leaderboard/data.json); [methods](https://cognition.com/blog/frontier-code-1.1) and https://cognition.com/blog/frontier-code) measures code quality rather than only correctness: would the maintainer merge this PR. Tasks come from 36 open-source repositories whose maintainers wrote the rubrics, grading behavioral correctness, regression safety, lint and style, test correctness, scope discipline, and adherence to codebase conventions. A run passes only if it clears every blocker criterion; score is the weighted aggregate of all rubric items, and blocker or unfair-internet-use failures score zero. Main is 100 tasks and Extended is 150.

Table: Main Best rows in source order. Columns: model, source effort label, harness, score, pass, flag (percent), USD/task, output k-tokens. Harness: `cc`=claude-code, `gb`=grok-build, `msa`=mini-swe-agent. `—`=source null, not 0; Inkling `0.99` is unexplained. Extended values remain linked (not routed).

| ID | Model | Effort | Harness | score | pass | flag | USD/task | output k-tokens |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| F01 | Claude Opus 5.5 | medium | cc | 54.6 | 59.6 | 0.0 | 0.80 | 18.5 |
| F02 | Claude Fable 5 | xhigh | cc | 53.5 | 58.9 | 0.3 | 13.09 | 58.6 |
| F03 | Claude Opus 5 | medium | cc | 53.4 | 58.9 | 0.6 | 4.31 | 33.6 |
| F04 | GPT-6 Astra | max | codex | 53.3 | 58.8 | — | 4.59 | 30.1 |
| F05 | Claude Fable 5.1 | medium | cc | 50.9 | 55.5 | 0.0 | 3.28 | 26.1 |
| F06 | SWE-2 | max | devin | 50.0 | 55.5 | — | 1.18 | 72.8 |
| F07 | GPT-6 Sol | max | codex | 49.3 | 54.3 | 0.0 | 2.07 | 41.3 |
| F08 | Grok 4.6 | high | gb | 48.0 | 53.1 | 0.7 | 2.88 | 36.8 |
| F09 | GPT-5.6 Sol | max | codex | 47.5 | 52.9 | 0.0 | 5.19 | 33.2 |
| F10 | Claude Opus 4.8 | max | cc | 46.5 | 51.6 | 0.6 | 9.62 | 95.9 |
| F11 | Kimi K3 | none | msa | 44.2 | 48.9 | 0.2 | 3.82 | 53.6 |
| F12 | Gemini 3.7 Flash | medium | chisel | 43.6 | 48.9 | 0.0 | 1.82 | 51.1 |
| F13 | GPT-5.5 | xhigh | codex | 43.0 | 48.2 | 0.4 | 4.03 | 25.0 |
| F14 | Claude Sonnet 5 | xhigh | cc | 42.7 | 47.6 | 0.5 | 10.07 | 87.9 |
| F15 | Grok 4.5 | high | gb | 42.4 | 47.2 | 0.0 | 1.30 | 15.3 |
| F16 | GPT-6 Luna | max | codex | 42.4 | 47.8 | 0.0 | 0.10 | 56.6 |
| F17 | SWE-1.7 | none | chisel | 42.0 | 47.4 | 1.2 | 1.97 | 64.8 |
| F18 | GPT-5.6 Terra | max | codex | 41.3 | 46.3 | 0.1 | 1.87 | 40.5 |
| F19 | Gemini 3.8 Flash | medium | chisel | 41.2 | 46.7 | 0.0 | 2.60 | 78.9 |
| F20 | GLM 5.3 | max | chisel | 40.1 | 44.7 | 0.0 | 16.91 | 112.2 |
| F21 | GPT-5.6 Luna | max | codex | 39.8 | 44.7 | 0.1 | 0.37 | 37.4 |
| F22 | Claude Opus 4.7 | max | cc | 38.5 | 42.8 | 0.1 | 9.09 | 49.1 |
| F23 | Gemini 3.6 Flash | medium | chisel | 34.4 | 38.9 | 0.0 | 4.04 | 46.7 |
| F24 | GLM 5.3 Flash | max | chisel | 31.8 | 35.7 | 0.0 | 1.15 | 169.3 |
| F25 | Kimi K2.7 | none | msa | 30.1 | 33.6 | 0.0 | 3.01 | 43.9 |
| F26 | DeepSeek V4 Pro 0813 | high | chisel | 28.5 | 31.8 | 10.6 | 1.81 | 104.7 |
| F27 | GPT-5.4-mini | xhigh | codex | 27.0 | 30.8 | 0.0 | 1.52 | 90.9 |
| F28 | Claude Opus 4.6 | high | cc | 26.6 | 29.7 | 0.1 | 3.98 | 26.7 |
| F29 | Composer 2.5 | none | cursor | 25.6 | 29.3 | 2.4 | 3.09 | 16.0 |
| F30 | GLM 5.2 | none | msa | 24.5 | 27.4 | 0.0 | 2.47 | 17.8 |
| F31 | Claude Sonnet 4.6 | max | cc | 24.3 | 27.5 | 0.2 | 2.90 | 44.2 |
| F32 | DeepSeek V4 Flash 0731 | high | chisel | 18.8 | 21.1 | 25.5 | 1.53 | 94.4 |
| F33 | DeepSeek V4 Pro | none | msa | 17.6 | 20.0 | 1.0 | 1.55 | 28.8 |
| F34 | MiniMax M3 | none | msa | 14.7 | 16.6 | 1.5 | 0.68 | 34.0 |
| F35 | Inkling | 0.99 | msa | 14.0 | 15.9 | 7.6 | 3.60 | 33.6 |
| F36 | Nemotron 3 Ultra | none | chisel | 13.6 | 15.4 | 0.2 | 1.47 | 27.7 |
| F37 | Qwen 3.7 Plus | none | msa | 10.2 | 11.5 | 0.9 | 0.24 | 45.3 |
| F38 | SWE-1.6 | none | chisel | 9.4 | 10.4 | 0.0 | 0.49 | 19.8 |
| F39 | Mistral 3.5 Medium | none | chisel | 8.0 | 9.0 | 0.6 | 1.35 | 22.5 |
