# voltura-proof

These are three test suites copied byte-for-byte from Voltura's private production repo at commit `a15dd1d` (production since 21 Oct 2026), with the code they run. The full repo is private.

## Run

Node 24, pnpm 11:

```
pnpm install
pnpm test
```

No database, no network, no keys.

## The suites

**A — Córdoba summer heat-risk index (method `h3-index-v2`).** Energy-certificate weight by Bühlmann–Straub credibility, k measured per age band from Córdoba's 30,586 certificate entries (pre-1980 5.586, 1980–2006 6.569, 2007 on 2.583). 33 tests.

**B — CTE DB-HE tables** (Spain's building code: climate zones, July solar irradiation, `qsol;jul`). 72 tests.

**C — NASA POWER regression.** NASA keys monthly data `YYYYMM`; the old code looked up `2022JAN`, every lookup missed, and `|| 4.0` fabricated the same irradiance for every place on Earth while reporting NASA as the source. The test runs on captured responses (Nominatim and NASA POWER, 22 Aug 2026). 21 tests.

## Live product

https://voltura-web.onrender.com (Córdoba screening at `/cribado`).

## Data credits

OpenStreetMap contributors (ODbL) for the Nominatim responses; NASA POWER.

## License

All rights reserved. No license is granted.
