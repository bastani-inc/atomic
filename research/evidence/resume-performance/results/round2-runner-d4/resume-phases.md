| project | stage | rep | fetch | reconstruct | materialize | lfs | verify | restore total | blueprint steps | blueprint total | startup+other | time to first prompt | cache download |
|---|---|---|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|
| ripgrep | runnercold | rep1 | 0.91 | 0.02 | 0.04 | 0.00 | 0.05 | 1.02 | Restore build cache (benchmark) 0.0; Fetch crates 1.1; Build 13.2 | 14.3 | 13.5 | **28.7** | 0.0 |
| ripgrep | runnercold | rep2 | 1.00 | 0.02 | 0.04 | 0.00 | 0.07 | 1.14 | Restore build cache (benchmark) 0.0; Fetch crates 1.2; Build 12.9 | 14.1 | 13.7 | **29.0** | 0.0 |
| ripgrep | runnerstores | rerun1 | 0.89 | 0.03 | 0.06 | 0.00 | 0.07 | 1.05 | Restore build cache (benchmark) 0.0; Fetch crates 0.6; Build 14.3 | 14.9 | 5.5 | **21.5** | 0.7 |
| ripgrep | runnerstores | rerun2 | 0.91 | 0.03 | 0.05 | 0.00 | 0.05 | 1.03 | Restore build cache (benchmark) 0.0; Fetch crates 0.6; Build 16.3 | 16.9 | 5.5 | **23.5** | 0.8 |
| ripgrep | runnerfull | rerun1 | 0.84 | 0.03 | 0.06 | 0.00 | 0.08 | 1.00 | Restore build cache (benchmark) 0.6; Fetch crates 0.3; Build 6.7 | 7.6 | 4.7 | **13.3** | 1.5 |
| ripgrep | runnerfull | rerun2 | 0.87 | 0.03 | 0.05 | 0.00 | 0.08 | 1.04 | Restore build cache (benchmark) 0.6; Fetch crates 0.3; Build 6.1 | 7.0 | 4.3 | **12.4** | 1.4 |
| fastapi | runnercold | rep1 | 5.20 | 0.04 | 0.39 | 0.00 | 0.39 | 6.01 | Restore build cache (benchmark) 0.0; Install dependencies 4.7 | 4.7 | 13.9 | **24.6** | 0.0 |
| fastapi | runnercold | rep2 | 5.23 | 0.04 | 0.39 | 0.00 | 0.39 | 6.05 | Restore build cache (benchmark) 0.0; Install dependencies 4.8 | 4.8 | 14.2 | **25.0** | 0.0 |
| fastapi | runnerstores | rerun1 | 5.12 | 0.04 | 0.41 | 0.00 | 0.39 | 5.97 | Restore build cache (benchmark) 0.0; Install dependencies 0.8 | 0.8 | 4.1 | **10.9** | 3.5 |
| fastapi | runnerstores | rerun2 | 5.08 | 0.04 | 0.40 | 0.00 | 0.39 | 5.92 | Restore build cache (benchmark) 0.0; Install dependencies 0.8 | 0.8 | 4.1 | **10.9** | 3.3 |
| fastapi | runnerfull | rerun1 | 5.17 | 0.04 | 0.41 | 0.00 | 0.17 | 5.79 | Restore build cache (benchmark) 1.4; Install dependencies 1.4 | 2.8 | 4.5 | **13.1** | 4.8 |
| fastapi | runnerfull | rerun2 | 5.12 | 0.04 | 0.45 | 0.00 | 0.17 | 5.77 | Restore build cache (benchmark) 1.2; Install dependencies 1.1 | 2.3 | 5.0 | **13.1** | 4.7 |
| atomic | runnercold | rep1 | 14.23 | 1.04 | 1.39 | 6.64 | 0.20 | 23.51 | Restore build cache (benchmark) 0.0; Install dependencies 10.7; Build 71.0 | 81.7 | 15.1 | **120.4** | 0.0 |
| atomic | runnercold | rep2 | 14.27 | 1.05 | 1.41 | 6.59 | 0.21 | 23.54 | Restore build cache (benchmark) 0.0; Install dependencies 11.1; Build 71.4 | 82.5 | 14.4 | **120.5** | 0.0 |
| atomic | runnerstores | rep1 | 14.12 | 1.03 | 1.39 | 6.01 | 0.19 | 22.75 | Restore build cache (benchmark) 0.0; Install dependencies 8.8; Build 70.2 | 79.0 | 8.1 | **109.9** | 2.3 |
| atomic | runnerstores | rep2 | 14.26 | 1.04 | 1.39 | 6.73 | 0.20 | 23.62 | Restore build cache (benchmark) 0.0; Install dependencies 8.7; Build 68.7 | 77.4 | 6.6 | **107.6** | 2.7 |
| atomic | runnerfull | rep1 | 14.08 | 1.05 | 1.40 | 5.87 | 0.22 | 22.62 | Restore build cache (benchmark) 1.8; Install dependencies 4.5; Build 30.7 | 37.0 | 4.4 | **64.1** | 4.3 |
| atomic | runnerfull | rep2 | 15.73 | 1.15 | 1.52 | 7.29 | 0.21 | 25.91 | Restore build cache (benchmark) 2.1; Install dependencies 3.1; Build 28.5 | 33.7 | 7.5 | **67.2** | 4.0 |
| atomic | cold | warm | 14.61 | 1.03 | 1.42 | 6.06 | 0.19 | 23.32 | Restore build cache (benchmark) 0.0; Install dependencies 11.1; Build 73.1 | 84.1 | 2.3 | **109.8** | 0.0 |
| atomic | warmstores | warm | 13.85 | 1.03 | 1.47 | 5.92 | 0.20 | 22.47 | Restore build cache (benchmark) 0.0; Install dependencies 7.8; Build 66.7 | 74.5 | 2.3 | **99.3** | 0.0 |
| atomic | warmlocal | warm | 0.01 | 0.01 | 1.56 | 0.79 | 0.21 | 2.60 | Restore build cache (benchmark) 0.0; Install dependencies 7.9; Build 67.7 | 75.6 | 2.4 | **80.6** | 0.0 |
