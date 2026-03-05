# Token Audit (MVP)

A lightweight analyzer for context size and token hotspots.

## What it does

- Recursively scans files
- Estimates token count per file (`chars / 4` heuristic)
- Reports top heavy files + folder-level totals
- Exports JSON and optional HTML dashboard

## Usage

```bash
node token-audit.js --root . --top 25 --out reports/token-audit.json --html reports/token-audit.html
```

### Options

- `--root <path>`: scan root (default: current directory)
- `--top <n>`: number of top files in report (default: 20)
- `--out <file>`: write JSON report
- `--html <file>`: write HTML report
- `--all`: include all file extensions

## Notes

- This is an estimate for optimization decisions, not exact billing.
- Useful before commits to identify oversized context files.
