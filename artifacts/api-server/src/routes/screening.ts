/**
 * H3.9 — the screening portfolio, read-only.
 *
 *   GET /api/screening/municipalities
 *   GET /api/screening/:ine/buildings?age=&certificate=&district=&limit=&offset=
 *   GET /api/screening/:ine/buildings/:ref
 *   GET /api/screening/:ine/summary
 *   GET /api/screening/:ine/export.csv
 *
 * The data is public (Catastro, IGN, INE, the Junta's register) and holds no
 * personal record — no address, no name — so these routes take no session.
 *
 * A municipality with nothing loaded answers 404 with code
 * `screening_not_loaded`, in the reader's language. It never answers an empty
 * list: an empty ranking reads as "no building at risk".
 *
 * P7: every label here says "índice de cribado" / "screening index". Never a
 * grade, a rating or a compliance result.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import pLimit from "p-limit";
import type { Pool } from "pg";
import { clientKey } from "../lib/client-key";
import {
  AGE_FILTERS,
  ScreeningNotLoaded,
  buildingTrace,
  exportRows,
  listBuildings,
  listMunicipalities,
  portfolioSummary,
  type AgeFilter,
  type ListFilters,
  type PortfolioRow,
} from "@workspace/screening/db";
import { requestLocale, serverT, type ServerTranslate } from "../i18n";
import { logger } from "../lib/logger";

const INE = /^\d{5}$/;
const REF = /^[0-9A-Z]{14}$/;
const DISTRICT = /^\d{2}$/;
const MAX_LIMIT = 500;

class BadParam extends Error {
  constructor(readonly param: string) {
    super(`bad parameter ${param}`);
  }
}

/** A route parameter as one string (Express 5 types them string | string[]). */
function routeParam(req: Request, name: string): string {
  const v = (req.params as Record<string, unknown>)[name];
  if (typeof v !== "string") throw new BadParam(name);
  return v;
}

function intParam(raw: unknown, name: string, dflt: number, max: number): number {
  if (raw === undefined) return dflt;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) throw new BadParam(name);
  const n = Number(raw);
  if (n > max) throw new BadParam(name);
  return n;
}

export function parseFilters(q: Request["query"]): ListFilters {
  const f: { age?: AgeFilter; certificate?: "with" | "without"; district?: string } = {};
  if (q.age !== undefined) {
    if (typeof q.age !== "string" || !(AGE_FILTERS as readonly string[]).includes(q.age)) throw new BadParam("age");
    f.age = q.age as AgeFilter;
  }
  if (q.certificate !== undefined) {
    if (q.certificate !== "with" && q.certificate !== "without") throw new BadParam("certificate");
    f.certificate = q.certificate;
  }
  if (q.district !== undefined) {
    if (typeof q.district !== "string" || !DISTRICT.test(q.district)) throw new BadParam("district");
    f.district = q.district;
  }
  return f;
}

/** RFC 4180 field: quoted when it holds a comma, quote or line break. */
export function csvField(v: string | number | null): string {
  if (v === null) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: readonly PortfolioRow[], t: ServerTranslate): string {
  const head = [
    "csv.rank", "csv.ref", "csv.dwellings", "csv.year", "csv.floors", "csv.zone", "csv.cusec",
    "csv.low", "csv.mid", "csv.high", "csv.coverage", "csv.capped", "csv.census",
  ] as const;
  const yes = t("csv.yes");
  const no = t("csv.no");
  const lines = [head.map((k) => csvField(t(k))).join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.rank, r.ref, r.dwellings, r.year, r.floors, r.zone, r.cusec,
        r.index.low.toFixed(4), r.index.mid.toFixed(4), r.index.high.toFixed(4),
        r.certificateCoverage.toFixed(4), r.certificateCapped ? yes : no, r.censusSection ? yes : no,
      ].map(csvField).join(","),
    );
  }
  // CRLF per RFC 4180; a BOM so spreadsheet software reads the accents as UTF-8.
  return "﻿" + lines.join("\r\n") + "\r\n";
}

/**
 * H-D17B. Measured live on 23 Oct 2026: /summary took 2.7 s and /buildings
 * 1.8–3.5 s per request, with no limit. These queries share one database pool
 * (pg's default, 10 connections) with calculations and chat, so a script
 * firing them in parallel could stall every route at once. Three guards:
 *
 * - SCREENING_PER_MINUTE requests per client per minute on every screening
 *   route. The page makes three on load and one per filter or page change.
 * - At most SCREENING_CONCURRENCY screening requests use the database at once,
 *   whoever sends them, so the rest of the pool stays free for calculations and
 *   chat. Beyond SCREENING_MAX_QUEUE waiting, a typed 503 answers at once
 *   rather than letting requests pile up in memory.
 * - The municipality list and a municipality's summary are kept for
 *   SCREENING_CACHE_MS. They change only when a load runs (h3-load, by hand),
 *   so after a load the old figures can show for up to that long.
 */
export const SCREENING_PER_MINUTE = 30;
export const SCREENING_CONCURRENCY = 2;
export const SCREENING_MAX_QUEUE = 20;
export const SCREENING_CACHE_MS = 5 * 60 * 1000;

class ScreeningBusy extends Error {}

export function createScreeningRouter(pool: Pool, opts: { now?: () => number } = {}): IRouter {
  const router: IRouter = Router();
  const now = opts.now ?? Date.now;
  // H-D17: keyed by clientKey, which does not depend on Render's unpublished
  // proxy hop count. Proven per client on this route live, 23 Oct 2026.
  const exportLimiter = rateLimit({ windowMs: 60 * 1000, limit: 10, standardHeaders: "draft-7", legacyHeaders: false, keyGenerator: clientKey });
  router.use(
    "/api/screening",
    rateLimit({
      windowMs: 60 * 1000,
      limit: SCREENING_PER_MINUTE,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      keyGenerator: clientKey,
      message: (req: Request) => ({ code: "rate_limited", message: serverT(requestLocale(req))("error.screeningRateLimited") }),
    }),
  );

  const gate = pLimit(SCREENING_CONCURRENCY);
  const cache = new Map<string, { at: number; value: Promise<unknown> }>();
  /** A cached result if fresh; else computes it inside the gate. The promise is
   *  stored, so requests arriving while it computes share one query. A failure
   *  is dropped from the cache, so "not loaded" is answered fresh every time. */
  function cached<T>(key: string, compute: () => Promise<T>): Promise<T> {
    const hit = cache.get(key);
    if (hit && now() - hit.at < SCREENING_CACHE_MS) return hit.value as Promise<T>;
    const value = gated(compute);
    cache.set(key, { at: now(), value });
    value.catch(() => {
      if (cache.get(key)?.value === value) cache.delete(key);
    });
    return value;
  }
  function gated<T>(work: () => Promise<T>): Promise<T> {
    if (gate.pendingCount >= SCREENING_MAX_QUEUE) throw new ScreeningBusy();
    return gate(work);
  }

  const handle =
    (fn: (req: Request, res: Response, t: ServerTranslate) => Promise<void>) => async (req: Request, res: Response) => {
      const t = serverT(requestLocale(req));
      try {
        if ("ine" in req.params && !INE.test(routeParam(req, "ine"))) throw new BadParam("ine");
        await fn(req, res, t);
      } catch (err) {
        if (err instanceof ScreeningBusy) {
          res.setHeader("Retry-After", "10");
          res.status(503).json({ code: "screening_busy", message: t("error.screeningBusy") });
        } else if (err instanceof BadParam) {
          res.status(400).json({ code: "bad_param", param: err.param, message: t("error.screeningBadParam", { param: err.param }) });
        } else if (err instanceof ScreeningNotLoaded) {
          res.status(404).json({ code: "screening_not_loaded", message: t("error.screeningNotLoaded", { ine: err.ineMunicipality }) });
        } else {
          logger.error({ err }, "screening route failed");
          res.status(500).json({ code: "internal", message: t("error.internal") });
        }
      }
    };

  router.get(
    "/api/screening/municipalities",
    handle(async (_req, res) => {
      res.json({ municipalities: await cached("municipalities", () => listMunicipalities(pool)) });
    }),
  );

  router.get(
    "/api/screening/:ine/buildings",
    handle(async (req, res) => {
      const filters = parseFilters(req.query);
      const limit = intParam(req.query.limit, "limit", 50, MAX_LIMIT);
      const offset = intParam(req.query.offset, "offset", 0, Number.MAX_SAFE_INTEGER);
      if (limit === 0) throw new BadParam("limit");
      const ine = routeParam(req, "ine");
      res.json(await gated(() => listBuildings(pool, ine, filters, { limit, offset })));
    }),
  );

  router.get(
    "/api/screening/:ine/buildings/:ref",
    handle(async (req, res, t) => {
      const ref = routeParam(req, "ref");
      if (!REF.test(ref)) throw new BadParam("ref");
      const ine = routeParam(req, "ine");
      const trace = await gated(() => buildingTrace(pool, ine, ref));
      if (!trace) {
        res.status(404).json({ code: "building_not_found", message: t("error.screeningBuildingNotFound", { ref }) });
        return;
      }
      res.json(trace);
    }),
  );

  router.get(
    "/api/screening/:ine/summary",
    handle(async (req, res) => {
      const ine = routeParam(req, "ine");
      res.json(await cached(`summary:${ine}`, () => portfolioSummary(pool, ine)));
    }),
  );

  router.get(
    "/api/screening/:ine/export.csv",
    exportLimiter,
    handle(async (req, res, t) => {
      const ine = routeParam(req, "ine");
      const { runId, rows } = await gated(() => exportRows(pool, ine));
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="cribado-${ine}.csv"`);
      res.setHeader("X-Screening-Run", runId);
      res.send(toCsv(rows, t));
    }),
  );

  return router;
}
