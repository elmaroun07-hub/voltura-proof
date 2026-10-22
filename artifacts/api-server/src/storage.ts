import { db } from "./db";
import { calculations, type InsertCalculation, type Calculation } from "@workspace/db";
import { chatStorage } from "./replit_integrations/chat/storage";
import { and, desc, eq } from "drizzle-orm";

export interface IStorage {
  createCalculation(calc: InsertCalculation & {
    savingsKwh: number;
    co2Reduction: number;
    annualSavingsEur?: number | null;
    renewableMix?: { solar: number; wind: number };
    monthlyData?: any[];
    sessionId: string;
  }): Promise<Calculation>;
  getHistory(sessionId: string): Promise<Calculation[]>;
  // Session-scoped since H-S (finding F2). It was deliberately unscoped, because
  // its only caller is the PDF route and that route was reached by window.open,
  // which cannot carry a header. The consequence was an unauthenticated
  // sequential-id oracle over every calculation ever made. The web now fetches
  // the PDF with the header and downloads the blob, so the constraint is gone.
  //
  // sessionId is a required parameter, not an optional filter. There is no
  // overload that returns a row without it - that shape is exactly how the
  // unscoped read survived a review once already.
  getCalculationById(id: number, sessionId: string): Promise<Calculation | undefined>;
}

export class DatabaseStorage implements IStorage {
  async createCalculation(calc: any): Promise<Calculation> {
    const [result] = await db.insert(calculations).values(calc).returning();
    return result;
  }

  // sessionId is required, not optional: an unfiltered getHistory() is what the
  // exposure was. There is no overload that returns every row.
  //
  // Both predicates are in the query, so a row belonging to someone else and a
  // row that does not exist are the same `undefined` here. The caller cannot
  // tell them apart even if it wanted to - that is the point, and it is what
  // keeps the 404 free of an oracle.
  async getCalculationById(id: number, sessionId: string): Promise<Calculation | undefined> {
    const [row] = await db
      .select()
      .from(calculations)
      .where(and(eq(calculations.id, id), eq(calculations.sessionId, sessionId)));
    return row;
  }

  async getHistory(sessionId: string): Promise<Calculation[]> {
    return db
      .select()
      .from(calculations)
      .where(eq(calculations.sessionId, sessionId))
      .orderBy(desc(calculations.createdAt));
  }
}

export const storage = new DatabaseStorage();
export { chatStorage };
