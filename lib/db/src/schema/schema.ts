import { pgTable, text, serial, integer, boolean, timestamp, jsonb, real, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export * from "./models/chat";


export type MonthlyEntry = {
  month: number;
  name: string;
  generationKwh: number;
  consumptionKwh: number;
  savingsKwh: number;
  gridImportKwh: number;
  co2Kg: number;
};

export const calculations = pgTable(
  "calculations",
  {
    id: serial("id").primaryKey(),
    location: text("location").notNull(),
    energyUsage: integer("energy_usage").notNull(),
    pvWattage: integer("pv_wattage").notNull(),
    batteryCapacity: integer("battery_capacity").notNull(),
    electricityTariff: real("electricity_tariff").default(0.25).notNull(),
    batteryEfficiency: real("battery_efficiency").default(0.9).notNull(),
    panelOrientation: text("panel_orientation").default("south").notNull(),
    roofAngle: integer("roof_angle").default(30).notNull(),
    savingsKwh: integer("savings_kwh").notNull(),
    co2Reduction: integer("co2_reduction").notNull(),
    annualSavingsEur: real("annual_savings_eur").default(0),
    carbonFootprint: integer("carbon_footprint").default(0),
    installationCostEur: real("installation_cost_eur"),
    paybackYears: real("payback_years"),
    lifetimeSavingsEur: real("lifetime_savings_eur"),
    // `currency` is not a column (no DDL, G3): the ISO 4217 code the money figures were
    // computed in rides here so the PDF can render them. Absent on rows written before
    // H-SRC-ES-UK and on calculations for a country outside the registry.
    renewableMix: jsonb("renewable_mix").$type<{ solar: number; wind: number; currency?: "EUR" | "GBP" }>(),
    monthlyData: jsonb("monthly_data").$type<MonthlyEntry[]>(),
    // Nullable: rows written before session isolation have no id, and the
    // contract forbids backfilling or deleting them. Absence is rejected at
    // the API boundary instead, where it can fail loudly.
    sessionId: text("session_id"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (t) => [index("calculations_session_id_idx").on(t.sessionId)],
);

export const insertCalculationSchema = createInsertSchema(calculations).omit({
  id: true,
  createdAt: true,
  savingsKwh: true,
  co2Reduction: true,
  renewableMix: true,
  annualSavingsEur: true,
  monthlyData: true,
  carbonFootprint: true,
});

export const calculationInputSchema = z.object({
  // H-D17: capped. Unbounded, it went into the geocoder URL and the database row
  // at whatever length the body carried.
  location: z.string().min(2, "Please enter a valid location").max(200, "Please enter a valid location"),
  energyUsage: z.number().min(100).max(100000),
  pvWattage: z.number().min(100).max(100000),
  batteryCapacity: z.number().min(0).max(200),
  // Optional, and there is NO default (H-SRC-ES-UK, P0.7/P0.8). A missing tariff is
  // resolved server-side from the country registry, or the money figure is pending.
  // 0.25 used to be applied here to every country on Earth.
  electricityTariff: z.number().min(0.01).max(5).optional().nullable(),
  batteryEfficiency: z.number().min(0.5).max(1.0).default(0.9),
  panelOrientation: z.enum(["north", "south", "east", "west"]).default("south"),
  roofAngle: z.number().min(0).max(90).default(30),
  // Renamed from installationCostEur: it is in the calculation's own currency.
  installationCost: z.number().min(0).max(200000).optional().nullable(),
});

export type Calculation = typeof calculations.$inferSelect;
export type InsertCalculation = z.infer<typeof insertCalculationSchema>;
export type CalculationInput = z.infer<typeof calculationInputSchema>;
