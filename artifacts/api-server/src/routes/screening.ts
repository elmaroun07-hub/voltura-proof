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
import type { Pool } from "pg";
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

export function createScreeningRouter(pool: Pool): IRouter {
  const router: IRouter = Router();
  const exportLimiter = rateLimit({ windowMs: 60 * 1000, limit: 10, standardHeaders: "draft-7", legacyHeaders: false });

  const handle =
    (fn: (req: Request, res: Response, t: ServerTranslate) => Promise<void>) => async (req: Request, res: Response) => {
      const t = serverT(requestLocale(req));
      try {
        if ("ine" in req.params && !INE.test(routeParam(req, "ine"))) throw new BadParam("ine");
        await fn(req, res, t);
      } catch (err) {
        if (err instanceof BadParam) {
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
      res.json({ municipalities: await listMunicipalities(pool) });
    }),
  );

  router.get(
    "/api/screening/:ine/buildings",
    handle(async (req, res) => {
      const filters = parseFilters(req.query);
      const limit = intParam(req.query.limit, "limit", 50, MAX_LIMIT);
      const offset = intParam(req.query.offset, "offset", 0, Number.MAX_SAFE_INTEGER);
      if (limit === 0) throw new BadParam("limit");
      res.json(await listBuildings(pool, routeParam(req, "ine"), filters, { limit, offset }));
    }),
  );

  router.get(
    "/api/screening/:ine/buildings/:ref",
    handle(async (req, res, t) => {
      const ref = routeParam(req, "ref");
      if (!REF.test(ref)) throw new BadParam("ref");
      const trace = await buildingTrace(pool, routeParam(req, "ine"), ref);
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
      res.json(await portfolioSummary(pool, routeParam(req, "ine")));
    }),
  );

  router.get(
    "/api/screening/:ine/export.csv",
    exportLimiter,
    handle(async (req, res, t) => {
      const ine = routeParam(req, "ine");
      const { runId, rows } = await exportRows(pool, ine);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="cribado-${ine}.csv"`);
      res.setHeader("X-Screening-Run", runId);
      res.send(toCsv(rows, t));
    }),
  );

  return router;
}
