# voltura-proof

These are three test suites copied byte-for-byte from Voltura's private production repo at commit `1a04df3` (production since 24 Oct 2026), with the code they run. The full repo is private. The first copy (22 Oct 2026, commit `a15dd1d`) is in this repo's history.

The 58 code and data files are byte-identical to `1a04df3`. The config files (`package.json`, `tsconfig.json`, `tsconfig.base.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `.gitignore`, `.gitattributes`) were written for this repo. Comments in five files refer to documents in the private repo (`contracts/…`); those documents are not included.

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

- OpenStreetMap contributors (ODbL): Nominatim responses in the test fixture.
- NASA POWER: irradiance and temperature responses in the test fixture.
- Red Eléctrica de España (REE), Eurostat, Unión Española Fotovoltaica (UNEF), Department for Energy Security and Net Zero (DESNZ), Comisión Nacional de los Mercados y la Competencia (CNMC), Ministerio para la Transición Ecológica y el Reto Demográfico (MITECO), Instituto Geográfico Nacional (IGN): figures in `data/sources/`, each entry naming its source.
- Código Técnico de la Edificación, DB-HE (Ministerio de Transporte, Movilidad y Agenda Urbana): tables in `lib/cte/src/`.
- MITECO, Estrategia Nacional contra la Pobreza Energética 2026–2030: vocabulary in `lib/i18n/src/vocabulary.ts`.

## License

All rights reserved. No license is granted.
