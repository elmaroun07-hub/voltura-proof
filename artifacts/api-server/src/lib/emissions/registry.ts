/**
 * The sources registry loader — H-SRC-ES.
 *
 * `data/sources/es.yaml` at the repo root is the only place a Spanish
 * user-facing numeric constant may be declared. This module reads it, and
 * every resolver in this directory goes through `requireCurrentEntry()`
 * rather than touching the parsed file directly - that is the single choke
 * point where "no entry -> no figure" (AC1) is enforced.
 *
 * `basis` is read here as a plain string. The distinct TYPES for each basis
 * live in `./es.ts`, which is the module that actually cares about keeping
 * `generation` out of a consumer figure - this file's job stops at "the YAML
 * parsed, and every entry has the fields a registry entry must have".
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

export type RegistryStatus = "current" | "superseded" | "pending";

export interface RegistryEntry {
  id: string;
  value: number | null;
  unit: string | null;
  basis: string | null;
  authority: string | null;
  documentId: string | null;
  editionDate: string | null;
  activityYear: number | null;
  nextEditionExpected: string | null;
  path: string | null;
  status: RegistryStatus;
  supersedes: string | null;
  verifiedOn: string | null;
  notes: string | null;
}

const VALID_STATUS: readonly RegistryStatus[] = ["current", "superseded", "pending"];

/**
 * Walk upward from `startDir` looking for `relativePath`, rather than
 * trusting a fixed offset or `process.cwd()`.
 *
 * Both of those break in a way that fails silently or points at the wrong
 * file: `process.cwd()` is the PACKAGE directory when pnpm runs a workspace
 * script, not the repo root, and a hardcoded "../../../../.." is correct for
 * `src/lib/emissions/registry.ts` at dev time but wrong once esbuild bundles
 * this file into `dist/index.mjs` - `import.meta.url` then resolves relative
 * to `dist/`, three directories shallower than `src/lib/emissions/` was. A
 * search is the one form of path resolution that is correct in both cases,
 * because it does not assume how many directories deep the calling module
 * happens to live.
 */
export function findUpward(startDir: string, relativePath: string, maxLevels = 10): string {
  let dir = startDir;
  for (let i = 0; i < maxLevels; i++) {
    const candidate = join(dir, relativePath);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `emissions registry: could not find "${relativePath}" by walking up from "${startDir}". ` +
      "No Spanish carbon figure can be resolved without it — that is deliberate (H-SRC-ES, AC1).",
  );
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`emissions registry: ${context} must be a mapping, got ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

function str(rec: Record<string, unknown>, key: string, id: string): string | null {
  const v = rec[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") {
    throw new Error(`emissions registry entry "${id}": field "${key}" must be a string or null, got ${typeof v}`);
  }
  return v;
}

function num(rec: Record<string, unknown>, key: string, id: string): number | null {
  const v = rec[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "number") {
    throw new Error(`emissions registry entry "${id}": field "${key}" must be a number or null, got ${typeof v}`);
  }
  return v;
}

function parseEntry(raw: unknown): RegistryEntry {
  const rec = asRecord(raw, "each registry entry");
  const idField = rec.id;
  if (typeof idField !== "string" || idField.length === 0) {
    throw new Error(`emissions registry: an entry has a missing or non-string id (${JSON.stringify(idField)})`);
  }
  const id = idField;

  const statusField = rec.status;
  if (typeof statusField !== "string" || !VALID_STATUS.includes(statusField as RegistryStatus)) {
    throw new Error(
      `emissions registry entry "${id}": status must be one of ${VALID_STATUS.join(", ")}, got ${JSON.stringify(statusField)}`,
    );
  }

  return {
    id,
    value: num(rec, "value", id),
    unit: str(rec, "unit", id),
    basis: str(rec, "basis", id),
    authority: str(rec, "authority", id),
    documentId: str(rec, "document_id", id),
    editionDate: str(rec, "edition_date", id),
    activityYear: num(rec, "activity_year", id),
    nextEditionExpected: str(rec, "next_edition_expected", id),
    path: str(rec, "path", id),
    status: statusField as RegistryStatus,
    supersedes: str(rec, "supersedes", id),
    verifiedOn: str(rec, "verified_on", id),
    notes: str(rec, "notes", id),
  };
}

export function parseRegistry(yamlText: string): RegistryEntry[] {
  const doc = asRecord(parseYaml(yamlText), "the registry document");
  const entriesField = doc.entries;
  if (!Array.isArray(entriesField)) {
    throw new Error('emissions registry: expected a top-level "entries" array');
  }
  const entries = entriesField.map(parseEntry);

  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) {
      throw new Error(`emissions registry: duplicate id "${entry.id}"`);
    }
    seen.add(entry.id);
  }
  for (const entry of entries) {
    if (entry.supersedes && !seen.has(entry.supersedes)) {
      throw new Error(`emissions registry entry "${entry.id}": supersedes unknown id "${entry.supersedes}"`);
    }
  }

  return entries;
}

let cached: RegistryEntry[] | null = null;

/**
 * Load the registry. Cached after the first successful read: the file only
 * ever changes at deploy time, never while a process is running, so
 * re-parsing it per request would be pure cost with no correctness benefit.
 *
 * Pass `filePath` to bypass the cache and load a specific file — this is
 * what AC1's tests use to prove that deleting an entry breaks the resolver,
 * without touching the real registry or the module-level cache other tests
 * rely on.
 */
export function loadRegistry(filePath?: string): RegistryEntry[] {
  if (filePath) {
    return parseRegistry(readFileSync(filePath, "utf8"));
  }
  if (cached) return cached;
  const startDir = dirname(fileURLToPath(import.meta.url));
  const resolved = findUpward(startDir, "data/sources/es.yaml");
  cached = parseRegistry(readFileSync(resolved, "utf8"));
  return cached;
}

/** Test-only: forces the next no-argument loadRegistry() call to re-read from disk. */
export function _resetRegistryCacheForTests(): void {
  cached = null;
}

export function getEntry(id: string, entries: RegistryEntry[] = loadRegistry()): RegistryEntry | undefined {
  return entries.find((e) => e.id === id);
}

/**
 * The one function every resolver in this directory goes through. A missing
 * id, or an id whose status is not "current", throws — it never falls back
 * to a bare number. Delete an entry (or leave it "pending" / "superseded")
 * and every caller that needs it fails loudly instead of emitting an
 * unsourced figure. That failure is the mechanism behind AC1.
 */
export function requireCurrentEntry(id: string, entries: RegistryEntry[] = loadRegistry()): RegistryEntry {
  const entry = getEntry(id, entries);
  if (!entry) {
    throw new Error(`emissions registry: no entry "${id}" — a figure cannot be emitted without one`);
  }
  if (entry.status !== "current") {
    throw new Error(`emissions registry: entry "${id}" is ${entry.status}, not current — refusing to emit it`);
  }
  if (entry.value === null) {
    throw new Error(`emissions registry: entry "${id}" is marked current but carries no value`);
  }
  return entry;
}
