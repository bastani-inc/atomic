| project | stage | rep | fetch | reconstruct | materialize | lfs | verify | restore total | blueprint steps | blueprint total | startup+other | time to first prompt |
|---|---|---|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|
| ripgrep | cold | 1 | 0.87 | 0.02 | 0.04 | 0.00 | 0.07 | 1.01 | Restore build cache (benchmark) 0.0; Fetch crates 0.6; Build 6.6 | 7.1 | 1.9 | **10.1** |
| ripgrep | cold | 2 | 0.63 | 0.02 | 0.04 | 0.00 | 0.07 | 0.77 | Restore build cache (benchmark) 0.0; Fetch crates 0.6; Build 6.7 | 7.2 | 2.1 | **10.1** |
| ripgrep | warmstores | 1 | 0.61 | 0.02 | 0.04 | 0.00 | 0.08 | 0.76 | Restore build cache (benchmark) 0.0; Fetch crates 0.0; Build 6.6 | 6.6 | 1.9 | **9.3** |
| ripgrep | warmstores | 2 | 0.68 | 0.02 | 0.04 | 0.00 | 0.07 | 0.81 | Restore build cache (benchmark) 0.0; Fetch crates 0.0; Build 6.7 | 6.7 | 2.1 | **9.7** |
| ripgrep | warmlocal | 1 | 0.01 | 0.01 | 0.04 | 0.00 | 0.07 | 0.13 | Restore build cache (benchmark) 0.0; Fetch crates 0.0; Build 6.8 | 6.9 | 2.0 | **8.9** |
| ripgrep | warmlocal | 2 | 0.01 | 0.01 | 0.04 | 0.00 | 0.07 | 0.13 | Restore build cache (benchmark) 0.0; Fetch crates 0.0; Build 6.6 | 6.7 | 2.0 | **8.8** |
| fastapi | cold | 1 | 3.33 | 0.03 | 0.38 | 0.00 | 0.38 | 4.13 | Restore build cache (benchmark) 0.0; Install dependencies 4.2 | 4.2 | 2.1 | **10.4** |
| fastapi | cold | 2 | 3.13 | 0.03 | 0.38 | 0.00 | 0.35 | 3.90 | Restore build cache (benchmark) 0.0; Install dependencies 4.2 | 4.2 | 2.6 | **10.6** |
| fastapi | warmstores | 1 | 3.55 | 0.20 | 0.44 | 0.00 | 0.17 | 4.36 | Restore build cache (benchmark) 0.0; Install dependencies 0.6 | 0.6 | 2.2 | **7.2** |
| fastapi | warmstores | 2 | 2.96 | 0.03 | 0.38 | 0.00 | 0.38 | 3.77 | Restore build cache (benchmark) 0.0; Install dependencies 0.6 | 0.6 | 2.3 | **6.6** |
| fastapi | warmlocal | 1 | 0.01 | 0.01 | 0.39 | 0.00 | 0.72 | 1.15 | Restore build cache (benchmark) 0.0; Install dependencies 0.9 | 0.9 | 3.6 | **5.7** |
| fastapi | warmlocal | 2 | 0.01 | 0.01 | 0.39 | 0.00 | 0.38 | 0.79 | Restore build cache (benchmark) 0.0; Install dependencies 0.5 | 0.5 | 2.7 | **4.0** |
| atomic | cold | 1 | 9.91 | 1.03 | 1.37 | 6.01 | 0.20 | 18.53 | Restore build cache (benchmark) 0.0; Install dependencies 8.6; Build 33.3 | 41.9 | 2.3 | **62.8** |
| atomic | cold | 2 | 8.78 | 1.04 | 1.94 | 6.11 | 0.20 | 18.07 | Restore build cache (benchmark) 0.0; Install dependencies 8.9; Build 32.8 | 41.7 | 2.2 | **61.9** |
| atomic | warmstores | 1 | 9.21 | 1.03 | 1.38 | 6.38 | 0.20 | 18.21 | Restore build cache (benchmark) 0.0; Install dependencies 6.8; Build 28.8 | 35.6 | 2.6 | **56.4** |
| atomic | warmstores | 2 | 9.50 | 1.04 | 1.38 | 6.04 | 0.19 | 18.15 | Restore build cache (benchmark) 0.0; Install dependencies 6.7; Build 28.5 | 35.2 | 2.6 | **56.0** |
| atomic | warmlocal | 1 | 0.01 | 0.01 | 1.41 | 0.75 | 0.21 | 2.40 | Restore build cache (benchmark) 0.0; Install dependencies 6.6; Build 28.7 | 35.3 | 2.7 | **40.4** |
| atomic | warmlocal | 2 | 0.01 | 0.01 | 1.39 | 0.75 | 0.19 | 2.35 | Restore build cache (benchmark) 0.0; Install dependencies 6.7; Build 28.9 | 35.6 | 2.2 | **40.2** |
