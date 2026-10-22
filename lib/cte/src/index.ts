/**
 * @workspace/cte — Spanish building-code (CTE DB-HE) compliance primitives.
 *
 * Scope: this package implements the DB-HE **solar control** check (qsol;jul)
 * plus the winter-zone U-value limits. It does NOT produce a heat-habitability
 * grade. The A–E letters here are CTE *winter climate zones* — an input
 * describing the location — never an output describing the building.
 *
 * Zero runtime dependencies by design: lookup tables and pure functions only.
 */

export {
  type WinterZone,
  type SummerZone,
  type ClimateZone,
  type ProvinceCode,
  type AltitudeBand,
  type ZoneLookupResult,
  WINTER_ZONES,
  SUMMER_ZONES,
  ZONE_BY_PROVINCE_ALTITUDE,
  PROVINCE_KEYS,
  formatZone,
  parseZone,
  lookupZone,
} from './cte-zones';

export {
  type EnvelopeElement,
  type UComplianceResult,
  type ConstructionDefault,
  U_LIMITS,
  CONSTRUCTION_DEFAULTS,
  uLimit,
  checkU,
  airtightnessLimitQ100,
  hasConstructionDefaults,
} from './cte-u-limits';

export {
  type Archipelago,
  type Surface,
  type IrradiationRow,
  SOLAR_IRRADIATION_JULY,
  CANARY_PROVINCES,
  MissingIrradiationError,
  UnknownProvinceError,
  archipelagoForProvince,
  getHsolJul,
  orientationFromAzimuth,
} from './solar-irradiation';

export {
  type Orientation,
  type BuildingUse,
  type Opening,
  type QsolJulInput,
  type QsolJulResult,
  type QsolJulSuccess,
  type QsolJulError,
  type OpeningContribution,
  type IrradiationLookup,
  type SolarFactorEntry,
  QSOL_JUL_LIMIT,
  SOLAR_FACTORS,
  calculateQsolJul,
  hasSolarIrradiationData,
  orientationFromBearing,
} from './qsol-jul';
