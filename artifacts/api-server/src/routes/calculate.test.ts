import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { api } from "../shared-routes";

/**
 * Regression lock for the location -> irradiance path.
 *
 * Deterministic by construction: every outbound call is served from
 * calculate.fixtures.json, captured from live Nominatim and NASA POWER on
 * 22 Aug 2026. A test that needs the internet goes amber and gets ignored, and
 * this is the suite that has to still be trustworthy in a year.
 *
 * What it pins: NASA POWER keys monthly data YYYYMM. The code used to build
 * `2022${m}` from ["JAN",...], every lookup missed, and `|| 4.0` supplied a
 * fabricated 4.0 twelve times for every location on Earth - so Fuengirola and
 * Tetouan returned a byte-identical 4203 kWh / EUR 1050.70.
 */

type Fixture = { lat: number; lon: number; nominatim: any[]; nasa: any };
const fixtures: Record<string, Fixture> = JSON.parse(
  readFileSync(new URL("./calculate.fixtures.json", import.meta.url), "utf8"),
);

const FUENGIROLA = "Fuengirola, Málaga, Spain";
const TETOUAN = "Tétouan, Morocco";
const TROMSO = "Tromsø, Norway";
const ALMERIA = "Almería, Spain";

const realFetch = globalThis.fetch;

/** Per-test hook to bend one NASA payload without touching the fixture file. */
let nasaTransform: (nasa: any, loc: string) => any = (n) => n;

vi.mock("../db", () => ({ db: {}, pool: {} }));
vi.mock("../storage", () => ({
  storage: {
    createCalculation: async (calc: any) => ({ id: 1, ...calc }),
    getHistory: async () => [],
    getCalculationById: async () => undefined,
  },
  chatStorage: {},
}));

const { registerRoutes, fallbackIrradiance } = await import("./routes");

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function findByCoords(lat: string | null, lon: string | null) {
  return Object.entries(fixtures).find(
    ([, f]) => f.lat.toFixed(4) === lat && f.lon.toFixed(4) === lon,
  );
}

beforeEach(() => {
  nasaTransform = (n) => n;
  vi.stubGlobal("fetch", async (input: any, init?: any) => {
    const url = String(input);
    // The test's own calls to the server under test must not be intercepted.
    if (url.startsWith("http://127.0.0.1")) return realFetch(input, init);

    if (url.includes("nominatim.openstreetmap.org")) {
      const q = decodeURIComponent(new URL(url).searchParams.get("q") ?? "");
      const hit = fixtures[q];
      // Unknown location -> Nominatim's real empty-result shape.
      return json(hit ? hit.nominatim : []);
    }
    if (url.includes("power.larc.nasa.gov")) {
      const u = new URL(url);
      const hit = findByCoords(u.searchParams.get("latitude"), u.searchParams.get("longitude"));
      if (!hit) return json({}, 404);
      return json(nasaTransform(structuredClone(hit[1].nasa), hit[0]));
    }
    throw new Error(`unexpected outbound request in test: ${url}`);
  });
});

afterEach(() => vi.unstubAllGlobals());

async function serve() {
  const app = express();
  app.use(express.json());
  const httpServer = createServer(app);
  await registerRoutes(httpServer, app);
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

// H-D17: /api/calculate is rate-limited per client (20 per 15 minutes), and this
// file sends more than that from one process. Each test is its own client, a
// distinct IPv6 documentation-range address in CF-Connecting-IP - the header the
// limiter keys on in production - so no test spends another test's allowance.
let clientSeq = 0;
let client = "2001:db8:0::1";
beforeEach(() => {
  clientSeq += 1;
  client = `2001:db8:${clientSeq.toString(16)}::1`;
});

async function calculate(base: string, location: string) {
  const res = await realFetch(`${base}/api/calculate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-Session-Id": "a3a3a3a3-3333-4333-8333-a3a3a3a3a3a3",
      "CF-Connecting-IP": client,
      // This suite pins the English text, so it asks for English (H2b: Spanish is the default).
      "Accept-Language": "en",
    },
    body: JSON.stringify({
      location,
      energyUsage: 5000,
      pvWattage: 4000,
      batteryCapacity: 10,
    }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

describe("A3.1 regression pair — Fuengirola vs Tétouan", () => {
  it("does not return identical savings for two different cities", async () => {
    const { base, close } = await serve();
    const fuen = await calculate(base, FUENGIROLA);
    const tet = await calculate(base, TETOUAN);

    expect(fuen.status).toBe(200);
    expect(tet.status).toBe(200);

    // Non-equality only. They are ~110 km apart, so a small delta is
    // physically correct; any threshold here would be invented.
    expect(fuen.body.savingsKwh).not.toBe(tet.body.savingsKwh);
    // Money is compared no further: Tétouan's is pending by design (P0.8).
    expect(tet.body.money.annualSavings).toBeNull();
    expect(fuen.body.resolution.irradianceMonthly).not.toEqual(
      tet.body.resolution.irradianceMonthly,
    );
    await close();
  });

  it("consumes the real January irradiance, not a fabricated 4.0", async () => {
    const { base, close } = await serve();
    const fuen = await calculate(base, FUENGIROLA);

    // The 2019-2023 January mean for Fuengirola. 2022 alone was 2.6544; the
    // five-year mean is 2.7288, a 2.8% move on one month from widening the
    // period. That gap is the whole argument for H1.8 - a single year is not
    // a climate normal, and the difference reaches a euro figure.
    expect(fuen.body.resolution.irradianceMonthly[0]).toBeCloseTo(2.7288, 4);
    expect(fuen.body.resolution.irradianceMonthly.every((v: number) => v === 4)).toBe(false);
    await close();
  });
});

describe("A3.2 strong pair — Tromsø vs Almería", () => {
  it("moves the number substantially across ~33 degrees of latitude", async () => {
    const { base, close } = await serve();
    const tromso = await calculate(base, TROMSO);
    const almeria = await calculate(base, ALMERIA);

    expect(tromso.body.resolution.lat).toBeGreaterThan(60);
    expect(almeria.body.resolution.lat).toBeLessThan(40);

    // Almería must out-generate Tromsø by a wide margin. The ratio is asserted
    // loosely: the claim is "latitude moves this a lot", not a tuned constant.
    expect(almeria.body.savingsKwh).toBeGreaterThan(tromso.body.savingsKwh * 1.5);
    await close();
  });
});

describe("A3.3 array length — the 202213 guard", () => {
  it("consumes exactly twelve months for every fixture", async () => {
    const { base, close } = await serve();
    for (const loc of [FUENGIROLA, TETOUAN, TROMSO, ALMERIA]) {
      const r = await calculate(base, loc);
      expect(r.body.resolution.irradianceMonthly).toHaveLength(12);
      expect(r.body.monthlyData).toHaveLength(12);
    }
    await close();
  });

  it("the fixtures really do carry the thirteenth annual-mean key, every year", async () => {
    // If this ever fails, NASA changed shape and the guard above is untested.
    // Five years x (12 months + the YYYY13 annual mean) = 65. The annual mean
    // is present for EVERY year now, so the 202213 guard has to hold five
    // times over, not once.
    for (const loc of [FUENGIROLA, TETOUAN, TROMSO, ALMERIA]) {
      const keys = Object.keys(fixtures[loc].nasa.properties.parameter.ALLSKY_SFC_SW_DWN);
      expect(keys).toHaveLength(65);
      for (const year of [2019, 2020, 2021, 2022, 2023]) {
        expect(keys).toContain(`${year}13`);
      }
    }
  });
});

describe("A3.4 provenance", () => {
  it("reports nasa-live and the concrete period for a known-good location", async () => {
    const { base, close } = await serve();
    const r = await calculate(base, ALMERIA);

    expect(r.body.resolution.irradianceSource).toBe("nasa-live");
    // The period the mean was actually computed over, not the one requested.
    // H1.8: a mean without its period is not a citation.
    expect(r.body.resolution.irradiancePeriod).toEqual({ start: 2019, end: 2023 });
    expect(r.body.resolution.nasaHttpStatus).toBe(200);
    expect(r.body.resolution.geocodeStatus).toBe("resolved");
    // Requested and present key sets agree - the A1 mismatch is closed.
    expect(r.body.resolution.nasaKeysPresent).toEqual(r.body.resolution.nasaKeysRequested);
    await close();
  });
});

describe("A3.5 fallback honesty", () => {
  // These two pin the NON-FINITE case: the key is present and the value is
  // garbage. They used to produce it by deleting the key, which reached the
  // same NaN because the old code could not tell an absent key from a bad
  // value. H1.8 separates them - an absent key is partial coverage and is now
  // a hard error, tested below - so the mechanism here is now an actual
  // non-finite value, which is what the test always claimed to be about.
  it("one non-finite month fails the whole read and says fallback-lat", async () => {
    nasaTransform = (nasa) => {
      nasa.properties.parameter.ALLSKY_SFC_SW_DWN["202207"] = null;
      return nasa;
    };
    const { base, close } = await serve();
    const r = await calculate(base, FUENGIROLA);

    expect(r.status).toBe(200);
    expect(r.body.resolution.irradianceSource).toBe("fallback-lat");
    expect(r.body.resolution.irradiancePeriod).toBeNull();
    // No partial-NASA state: not 11 real months plus one invented one.
    expect(r.body.resolution.irradianceMonthly).toHaveLength(12);
    expect(r.body.resolution.irradianceMonthly[0]).not.toBeCloseTo(2.6544, 4);
    // The fallback still runs on the real geocoded latitude.
    expect(r.body.resolution.lat).toBeCloseTo(36.5388, 4);
    await close();
  });

  it("a non-finite temperature month fails the read too", async () => {
    nasaTransform = (nasa) => {
      nasa.properties.parameter.T2M["202203"] = "";
      return nasa;
    };
    const { base, close } = await serve();
    const r = await calculate(base, FUENGIROLA);

    expect(r.body.resolution.irradianceSource).toBe("fallback-lat");
    await close();
  });
});

/**
 * H1.0 and H1.8 — the parse boundary rejects rather than substitutes.
 *
 * Both of these are DATA defects: NASA answered, and the answer cannot carry a
 * number. The request fails with a typed error and produces no figure at all.
 * That is the difference from A3.5 above, where NASA's answer was malformed
 * and the labelled latitude fallback still applies.
 */
describe("A3.6 — the -999 fill value is rejected, never consumed", () => {
  it("returns a typed 422 and no number when NASA fills a month with -999", async () => {
    nasaTransform = (nasa) => {
      nasa.properties.parameter.ALLSKY_SFC_SW_DWN["202108"] = -999;
      return nasa;
    };
    const { base, close } = await serve();
    const r = await calculate(base, FUENGIROLA);

    expect(r.status).toBe(422);
    expect(r.body.code).toBe("nasa_fill_value");
    expect(r.body.message).toContain("-999");
    expect(r.body.message).toContain("ALLSKY_SFC_SW_DWN");
    // No figure of any kind came back.
    expect(r.body.savingsKwh).toBeUndefined();
    expect(r.body.resolution.irradianceMonthly).toEqual([]);
    expect(r.body.resolution.irradiancePeriod).toBeNull();
    expect(r.body.resolution.irradianceSource).toBe("not-reached");
    await close();
  });

  it("rejects -999 in temperature too, not just irradiance", async () => {
    nasaTransform = (nasa) => {
      nasa.properties.parameter.T2M["202002"] = -999;
      return nasa;
    };
    const { base, close } = await serve();
    const r = await calculate(base, FUENGIROLA);

    expect(r.status).toBe(422);
    expect(r.body.code).toBe("nasa_fill_value");
    expect(r.body.message).toContain("T2M");
    await close();
  });

  it("does not fall back to latitude on a fill value — that would be a substitution", async () => {
    nasaTransform = (nasa) => {
      nasa.properties.parameter.ALLSKY_SFC_SW_DWN["202108"] = -999;
      return nasa;
    };
    const { base, close } = await serve();
    const r = await calculate(base, FUENGIROLA);

    expect(r.body.resolution.irradianceSource).not.toBe("fallback-lat");
    expect(r.body.resolution.irradianceSource).not.toBe("nasa-live");
    await close();
  });
});

describe("A3.7 — partial coverage is an error, not a shorter mean", () => {
  it("returns a typed 422 when a requested month is absent from the response", async () => {
    nasaTransform = (nasa) => {
      delete nasa.properties.parameter.ALLSKY_SFC_SW_DWN["202007"];
      return nasa;
    };
    const { base, close } = await serve();
    const r = await calculate(base, FUENGIROLA);

    expect(r.status).toBe(422);
    expect(r.body.code).toBe("nasa_partial_coverage");
    // The message states what was actually covered, so the reader is not left
    // guessing which years the missing figure would have spanned.
    expect(r.body.message).toContain("59 of 60 months");
    expect(r.body.resolution.irradiancePeriod).toBeNull();
    await close();
  });

  it("does not silently average the years it did get", async () => {
    // A whole year absent. The tempting bug is a four-year mean reported as
    // five - the 4.0 defect's exact shape, a missing input quietly becoming a
    // plausible number.
    nasaTransform = (nasa) => {
      for (const mm of ["01","02","03","04","05","06","07","08","09","10","11","12"]) {
        delete nasa.properties.parameter.ALLSKY_SFC_SW_DWN[`2021${mm}`];
      }
      return nasa;
    };
    const { base, close } = await serve();
    const r = await calculate(base, FUENGIROLA);

    expect(r.status).toBe(422);
    expect(r.body.code).toBe("nasa_partial_coverage");
    expect(r.body.message).toContain("48 of 60 months");
    expect(r.body.savingsKwh).toBeUndefined();
    await close();
  });

  it("fallbackIrradiance throws on a non-finite latitude rather than defaulting to 45", async () => {
    expect(() => fallbackIrradiance(Number.NaN)).toThrow(/non-finite latitude/);
    expect(() => fallbackIrradiance(undefined as unknown as number)).toThrow(/non-finite latitude/);
    // Latitude 0 is a real place. The old `lat || 45` moved the equator to 45N.
    expect(() => fallbackIrradiance(0)).not.toThrow();
    expect(fallbackIrradiance(0).irradiance).toHaveLength(12);
    expect(fallbackIrradiance(0).irradiance).not.toEqual(fallbackIrradiance(45).irradiance);
  });
});

describe("A3.5b unresolvable location", () => {
  it("returns 422 carrying a not-reached provenance record", async () => {
    const { base, close } = await serve();
    const r = await calculate(base, "Xqzzyvwmpq Nowhereville 99999");

    expect(r.status).toBe(422);
    expect(r.body.code).toBe("geocode_failed");
    expect(r.body.resolution.geocodeStatus).toBe("failed");
    expect(r.body.resolution.irradianceSource).toBe("not-reached");
    expect(r.body.resolution.nasaHttpStatus).toBe("not-called");
    expect(r.body.resolution.lat).toBeNull();
    expect(r.body.resolution.irradianceMonthly).toEqual([]);
    // H-SRC-ES: geocoding never reached a country, so there is nothing to
    // resolve a carbon figure for — never a guess.
    expect(r.body.resolution.carbonSource).toEqual({ status: "not_reached" });
    await close();
  });
});

/**
 * H-SRC-ES — AC2: "The 0.4 unknown-country default is gone. Unknown country
 * -> typed error -> HTTP 400. Prove it with a request." A live request
 * against the real running server, through the real geocoder mock and the
 * real carbon resolver — not a unit test of resolveCarbonSource in
 * isolation (that lives in lib/emissions/carbon-source.test.ts).
 */
describe("D15 — unknown country is a typed 400, never a substituted number", () => {
  it("returns 400 with a typed code for a geocoded country with no registry and no legacy entry", async () => {
    const { base, close } = await serve();
    const r = await calculate(base, "Thimphu, Bhutan");

    expect(r.status).toBe(400);
    expect(r.body.code).toBe("unknown_carbon_country");
    expect(r.body.field).toBe("location");
    expect(typeof r.body.message).toBe("string");
    // No carbonIntensity, no co2Reduction — the response never reaches the
    // point where either would be computed from a substituted number.
    expect(r.body.carbonIntensity).toBeUndefined();
    expect(r.body.co2Reduction).toBeUndefined();
    // The rejection still carries full provenance, including WHICH country
    // could not be resolved — not a bare 400 with no explanation.
    expect(r.body.resolution.carbonSource).toEqual({
      status: "unknown_country",
      attempted: "Bhutan",
    });
    await close();
  });
});

/**
 * H-SRC-ES — AC3: "Every response carrying a carbon figure names authority,
 * document, edition date and activity year. A response without them fails a
 * test." Run against a live 200 response, not a hand-built fixture, and
 * checked against the actual response schema so a future drift between
 * routes.ts and shared-routes.ts fails here rather than only in production.
 */
describe("AC3 — every carbon-bearing response names its source", () => {
  it("a Spain response carries the sourced registry object with full provenance", async () => {
    const { base, close } = await serve();
    const r = await calculate(base, ALMERIA);

    expect(r.status).toBe(200);
    const parsed = api.calculations.create.responses[200].parse(r.body);
    const carbon = parsed.resolution.carbonSource;

    expect(carbon.status).toBe("sourced");
    if (carbon.status !== "sourced") throw new Error("unreachable");
    expect(carbon.country).toBe("spain");
    // A21: location-based, per electric system. The publication object replaces
    // the CNMC documentId/editionDate pair.
    expect(carbon.factor.basis).toBe("generation");
    expect(carbon.factor.system).toBe("peninsular");
    expect(carbon.factor.authority.length).toBeGreaterThan(0);
    expect(carbon.factor.publication.title.length).toBeGreaterThan(0);
    expect(carbon.factor.publication.published.length).toBeGreaterThan(0);
    expect(typeof carbon.factor.activityYear).toBe("number");

    // The top-level carbonIntensity (kg/kWh, unchanged field for the client)
    // agrees with the sourced g/kWh figure — one number, not two that could
    // drift apart.
    expect(r.body.carbonIntensity).toBeCloseTo(carbon.factor.valueGPerKwh / 1000, 9);
    await close();
  });

  it("a non-Spain response still names its status honestly, even though it is legacy/unsourced", async () => {
    const { base, close } = await serve();
    const r = await calculate(base, TETOUAN);

    expect(r.status).toBe(200);
    const parsed = api.calculations.create.responses[200].parse(r.body);
    const carbon = parsed.resolution.carbonSource;

    expect(carbon.status).toBe("unsourced_legacy");
    if (carbon.status !== "unsourced_legacy") throw new Error("unreachable");
    // Unchanged from before this block — carbon-intensity.ts's own table,
    // out of scope here (a second country is explicitly OUT).
    expect(carbon.valueKgPerKwh).toBe(0.543);
    expect(r.body.carbonIntensity).toBe(0.543);
    await close();
  });
});

// ── H2b — the API answers in Spanish unless English is asked for ─────────────

async function calculateIn(base: string, location: string, acceptLanguage: string | null, extra: Record<string, unknown> = {}) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "X-Session-Id": "b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2",
    "CF-Connecting-IP": client,
  };
  if (acceptLanguage !== null) headers["Accept-Language"] = acceptLanguage;
  const res = await realFetch(`${base}/api/calculate`, {
    method: "POST",
    headers,
    body: JSON.stringify({ location, energyUsage: 5000, pvWattage: 4000, batteryCapacity: 10, ...extra }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

describe("H2b — Spanish by default (2b.1), on the calculate route", () => {
  it("writes the recommendation and the money block's reasons in Spanish when no language is named", async () => {
    const { base, close } = await serve();
    try {
      const es = await calculateIn(base, FUENGIROLA, null);
      const en = await calculateIn(base, FUENGIROLA, "en");
      expect(es.status).toBe(200);
      // Same figures in both languages: only the words change.
      expect(es.body.savingsKwh).toBe(en.body.savingsKwh);
      expect(es.body.money.annualSavings).toBe(en.body.money.annualSavings);
      expect(es.body.money.installCost.reason).toBe(en.body.money.installCost.reason);

      expect(es.body.recommendation).toMatch(/^(¡Excelente!|¡Buen resultado!|Su sistema compensa)/);
      expect(es.body.recommendation).toMatch(/al año/);
      expect(en.body.recommendation).toMatch(/^(Excellent!|Great result!|Your system offsets)/);
      // Spain's install cost is a registry note (data, quoted as recorded) or a
      // battery refusal (our sentence, translated) — never English prose of ours in Spanish.
      if (es.body.money.installCost.reason === "battery_not_in_registry_cost") {
        expect(es.body.money.installCost.detail).toMatch(/cubre solo la FV/);
      }
      expect(es.body.money.roi.detail).not.toMatch(/\b(the|there is|a payback)\b/);
    } finally {
      await close();
    }
  });

  it("refuses an unlocatable place in Spanish, with the same code and status", async () => {
    const { base, close } = await serve();
    try {
      const es = await calculateIn(base, "zzzz-no-such-place-zzzz", null);
      const en = await calculateIn(base, "zzzz-no-such-place-zzzz", "en");
      expect(es.status).toBe(en.status);
      expect(es.body.code).toBe(en.body.code);
      if (es.body.code === "geocode_failed") {
        expect(es.body.message).toMatch(/^No hemos podido localizar ese lugar/);
        expect(en.body.message).toMatch(/^We could not locate that place/);
      }
    } finally {
      await close();
    }
  });

  it("answers a missing session header in Spanish, and in English on request", async () => {
    const { base, close } = await serve();
    try {
      const es = await realFetch(`${base}/api/calculate`, { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": client }, body: "{}" });
      expect(es.status).toBe(400);
      expect(await es.json()).toEqual({ message: "Falta la cabecera X-Session-Id" });
      const en = await realFetch(`${base}/api/calculate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept-Language": "en", "CF-Connecting-IP": client },
        body: "{}",
      });
      expect(await en.json()).toEqual({ message: "X-Session-Id header is required" });
    } finally {
      await close();
    }
  });
});
