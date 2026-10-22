import { db } from "../../db";
import { conversations, messages } from "@workspace/db";
import { and, eq, desc } from "drizzle-orm";

export interface IChatStorage {
  getConversation(id: number): Promise<typeof conversations.$inferSelect | undefined>;
  getAllConversations(sessionId: string): Promise<(typeof conversations.$inferSelect)[]>;
  createConversation(title: string, sessionId: string): Promise<typeof conversations.$inferSelect>;
  deleteConversation(id: number, sessionId: string): Promise<void>;
  getMessagesByConversation(conversationId: number): Promise<(typeof messages.$inferSelect)[]>;
  createMessage(conversationId: number, role: string, content: string): Promise<typeof messages.$inferSelect>;
}

export const chatStorage: IChatStorage = {
  // Returns the row regardless of owner. The caller compares session ids and
  // answers 404 on a mismatch - filtering here instead would make "not yours"
  // and "does not exist" indistinguishable to the route, which is right, but
  // the route also needs the row to exist to delete it.
  async getConversation(id: number) {
    const [conversation] = await db.select().from(conversations).where(eq(conversations.id, id));
    return conversation;
  },

  async getAllConversations(sessionId: string) {
    return db
      .select()
      .from(conversations)
      .where(eq(conversations.sessionId, sessionId))
      .orderBy(desc(conversations.createdAt));
  },

  async createConversation(title: string, sessionId: string) {
    const [conversation] = await db.insert(conversations).values({ title, sessionId }).returning();
    return conversation;
  },

  // Scoped by session id as well as row id, so a mismatched delete is a no-op
  // at the storage layer even if a caller ever skips the ownership check.
  async deleteConversation(id: number, sessionId: string) {
    await db.delete(messages).where(eq(messages.conversationId, id));
    await db
      .delete(conversations)
      .where(and(eq(conversations.id, id), eq(conversations.sessionId, sessionId)));
  },

  async getMessagesByConversation(conversationId: number) {
    return db.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(messages.createdAt);
  },

  async createMessage(conversationId: number, role: string, content: string) {
    const [message] = await db.insert(messages).values({ conversationId, role, content }).returning();
    return message;
  },
};
