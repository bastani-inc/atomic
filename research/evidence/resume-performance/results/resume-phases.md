| project | stage | rep | fetch | reconstruct | materialize | lfs | verify | restore total | blueprint steps | blueprint total | startup+other | time to first prompt |
|---|---|---|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|
| ripgrep | cold | 1 | 0.56 | 0.05 | 0.06 | 0.00 | 0.12 | 0.79 | Fetch crates 0.7; Build 8.6 | 9.3 | 1.8 | **11.9** |
| ripgrep | cold | 2 | 0.78 | 0.07 | 0.07 | 0.00 | 0.15 | 1.09 | Fetch crates 0.8; Build 8.6 | 9.4 | 1.8 | **12.3** |
| ripgrep | warmstores | 1 | 0.64 | 0.05 | 0.06 | 0.00 | 0.12 | 0.88 | Fetch crates 0.1; Build 7.8 | 7.9 | 1.9 | **10.7** |
| ripgrep | warmstores | 2 | 0.61 | 0.04 | 0.05 | 0.00 | 0.09 | 0.80 | Fetch crates 0.1; Build 7.1 | 7.2 | 1.5 | **9.4** |
| ripgrep | warmlocal | 1 | 0.01 | 0.02 | 0.08 | 0.00 | 0.15 | 0.28 | Fetch crates 0.1; Build 11.5 | 11.6 | 2.1 | **14.0** |
| ripgrep | warmlocal | 2 | 0.01 | 0.01 | 0.05 | 0.00 | 0.10 | 0.18 | Fetch crates 0.1; Build 7.0 | 7.1 | 1.4 | **8.7** |
| t3turbo | cold | 1 | 1.11 | 0.09 | 0.10 | 0.00 | 0.17 | 1.50 | Install pnpm 2.0; Install dependencies 27.1 | 29.1 | 3.1 | **33.7** |
| t3turbo | cold | 2 | 0.56 | 0.05 | 0.04 | 0.00 | 0.09 | 0.74 | Install pnpm 0.8; Install dependencies 9.2 | 10.0 | 1.5 | **12.3** |
| t3turbo | warmstores | 1 | 1.04 | 0.09 | 0.07 | 0.00 | 0.15 | 1.37 | Install pnpm 1.9; Install dependencies 13.5 | 15.5 | 2.6 | **19.5** |
| t3turbo | warmstores | 2 | 0.59 | 0.05 | 0.04 | 0.00 | 0.08 | 0.77 | Install pnpm 0.6; Install dependencies 5.5 | 6.1 | 1.5 | **8.4** |
| t3turbo | warmlocal | 1 | 0.01 | 0.01 | 0.04 | 0.00 | 0.08 | 0.15 | Install dependencies 5.3 | 5.3 | 1.4 | **6.9** |
| t3turbo | warmlocal | 2 | 0.01 | 0.01 | 0.04 | 0.00 | 0.08 | 0.14 | Install dependencies 5.4 | 5.4 | 1.4 | **6.9** |
| fastapi | cold | 1 | 2.25 | 0.06 | 0.37 | 0.00 | 0.27 | 2.96 | Install dependencies 5.3 | 5.3 | 0.9 | **9.2** |
| fastapi | cold | 2 | 1.92 | 0.05 | 0.34 | 0.00 | 0.08 | 2.40 | Install dependencies 5.1 | 5.1 | 1.6 | **9.0** |
| fastapi | warmstores | 1 | 2.85 | 0.05 | 0.34 | 0.00 | 0.16 | 3.41 | Install dependencies 1.5 | 1.5 | 1.5 | **6.4** |
| fastapi | warmstores | 2 | 1.98 | 0.05 | 0.35 | 0.00 | 0.11 | 2.50 | Install dependencies 1.6 | 1.6 | 1.5 | **5.6** |
| fastapi | warmlocal | 1 | 0.01 | 0.01 | 0.33 | 0.00 | 0.09 | 0.45 | Install dependencies 1.3 | 1.3 | 1.5 | **3.3** |
| fastapi | warmlocal | 2 | 0.01 | 0.01 | 0.33 | 0.00 | 0.39 | 0.75 | Install dependencies 1.4 | 1.4 | 1.4 | **3.5** |
| atomic | cold | 1 | 8.51 | 0.70 | 1.03 | 6.10 | 0.22 | 16.58 | Install dependencies 5.1; Build 61.0 | 66.1 | 2.8 | **85.5** |
| atomic | cold | 2 | 6.86 | 0.73 | 1.04 | 5.60 | 0.22 | 14.46 | Install dependencies 5.5; Build 37.8 | 43.3 | 1.7 | **59.4** |
| atomic | warmstores | 1 | 10.79 | 0.89 | 1.31 | 5.86 | 0.24 | 19.10 | Install dependencies 4.7; Build 34.0 | 38.8 | 1.9 | **59.8** |
| atomic | warmstores | 2 | 6.97 | 0.70 | 1.01 | 5.51 | 0.21 | 14.42 | Install dependencies 4.4; Build 46.2 | 50.6 | 2.1 | **67.1** |
| atomic | warmlocal | 1 | 0.01 | 0.02 | 1.02 | 0.51 | 0.20 | 1.77 | Install dependencies 3.6; Build 33.6 | 37.2 | 1.5 | **40.5** |
| atomic | warmlocal | 2 | 0.01 | 0.03 | 1.19 | 0.60 | 0.25 | 2.10 | Install dependencies 5.3; Build 37.9 | 43.2 | 1.7 | **47.0** |
