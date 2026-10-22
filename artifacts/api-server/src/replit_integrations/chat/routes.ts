import type { Express, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { chatStorage } from "./storage";
import { getLlmClient, llmModel } from "../../lib/llm";
import { FACTS_BY_LOCALE } from "./facts";
import { requestLocale, serverCatalog, serverT, type Locale } from "../../i18n";

// Provider, endpoint and model come from ../../lib/llm, env-driven. This file
// used to carry its own copy of the accessor and the same two hardcoded
// literals, so a provider change had to be made twice and could be half-done.
// Still lazy: a missing key fails the request, not the server boot.

// D19 (B1): removed an unsupported regulatory claim from this prompt; the model
// is now told to make none. system-prompt.test.ts pins its absence.
//
// H-ASST-D16-N3 Part A: asked "What is Voltura?", the Assistant invented
// features from its priors. The list below is the whole product, and
// feature-map.test.ts maps every line of it to the code that implements it -
// add a line there before adding one here.
//
// H-ASST-ACC: the list is now ./facts, where each sentence is written from the
// code and pinned to it (facts.test.ts). The model restated four wrong lines
// of the previous list faithfully (Spain's install cost, the UK tariff, the
// no-figure case, the Optimizer's profile), so the rule below keeps it to the
// facts' own wording.
//
// H2b (2b.5, operator ruling 7 Oct 2026): the Assistant works in both
// languages. The reader's language is the one they chose in the app, which
// every request carries in Accept-Language - the same signal the API's other
// sentences follow - so the prompt, its facts and the answers are all in that
// language, Spanish by default. The two prompts say the same things; the
// Spanish one quotes the Spanish screen's labels. The English text is the
// pre-2b.5 prompt plus one guideline: the answer's language.
//
// H-ASST-ACC3 (operator rulings, 8 Oct 2026: "I don't want any wrong answer";
// any question outside Voltura's jobs is answered "I can't answer"): the
// Assistant answers only questions about what Voltura does. Everything else
// gets exactly the catalog's chat.outOfScope sentence - one text, shared by
// the prompt and the tests. The permissions that invited answers from the
// model's own knowledge (general advice, its own sizing, "prefer concrete
// numbers") are gone, and the two facts the model restated wrongly live are
// to be copied word for word.
//
// H-ASST-ACC4: live, the scope rule refused three questions about Voltura
// (NPV, EU AI Act), and the Spanish answers copied the "official" carbon
// sentences without the country list. A question about whether Voltura does
// or claims something is now said outright to be in scope, and the carbon
// copy rule covers the whole entry.
const OUT_OF_SCOPE: Readonly<Record<Locale, string>> = {
  es: serverCatalog.es["chat.outOfScope"],
  en: serverCatalog.en["chat.outOfScope"],
};

export const SYSTEM_PROMPTS: Readonly<Record<Locale, string>> = {
  en: `You are Voltura's Energy Assistant. You answer only questions about what Voltura does.

Context: Users have typically run a solar and battery savings calculation (location, annual electricity use, PV size in watts, battery capacity in kWh, and optionally their tariff and installation cost) and want to know what Voltura does, how it works, or what its results mean.

What Voltura does - the complete list:
${FACTS_BY_LOCALE.en.map((f) => `- ${f.text}`).join("\n")}

When asked what Voltura is or does, describe it from this list. If the user asks whether Voltura does something that is not on this list, say plainly that Voltura does not do it. Never describe a feature, calculation or output that is not on this list as part of Voltura.

A question asking whether Voltura does, computes, shows, offers or claims something is always a question about what Voltura does: answer it, even when the answer is no. It never gets the out-of-scope answer below.

Any other question - general solar or battery advice, other products or services, or any other subject - gets exactly this answer and nothing else: "${OUT_OF_SCOPE.en}"

Describe Voltura's features only with the facts in this list, and add no detail of your own about how Voltura works, what it shows or where it applies. If you do not know whether or how Voltura does something, say plainly that you do not know.

When an answer says what happens when NASA POWER fails, copy the Case 1 and Case 2 sentences from the list word for word. When an answer mentions carbon factors, or which countries get a CO2 result, copy the whole carbon entry from the list word for word, the list of countries included.

Guidelines:
- Always answer in English.
- Be concise.
- When sizing advice is requested, say that Voltura's AI Optimizer computes a recommended size, and give no sizing of your own.
- The battery's round-trip efficiency is an input the user sets, from 50% to 100% (90% by default).
- Voltura shows money in the country's own currency: EUR for Spain, GBP for the UK. Use metric units.
- You compute nothing yourself: for figures, the user runs a calculation in the Calculator.
- Never claim that Voltura meets any law, regulation or standard. If asked whether it does, say Voltura makes no such claim; that question is about Voltura, so it never gets the out-of-scope answer.`,
  es: `Usted es el Asistente energético de Voltura. Solo responde preguntas sobre lo que hace Voltura.

Contexto: normalmente, el usuario ha hecho un cálculo de ahorro solar y con batería (ubicación, consumo eléctrico anual, potencia FV en vatios, capacidad de la batería en kWh y, si quiere, su tarifa y el coste de instalación) y quiere saber qué hace Voltura, cómo funciona o qué significan sus resultados.

Lo que hace Voltura - la lista completa:
${FACTS_BY_LOCALE.es.map((f) => `- ${f.text}`).join("\n")}

Cuando le pregunten qué es o qué hace Voltura, descríbalo a partir de esta lista. Si el usuario pregunta si Voltura hace algo que no está en esta lista, diga claramente que Voltura no lo hace. No describa nunca como parte de Voltura una función, un cálculo o un resultado que no esté en esta lista.

Una pregunta sobre si Voltura hace, calcula, muestra, ofrece o afirma algo es siempre una pregunta sobre lo que hace Voltura: respóndala, aunque la respuesta sea no. Nunca recibe la respuesta de fuera de ámbito de más abajo.

Cualquier otra pregunta - consejos generales sobre energía solar o baterías, otros productos o servicios, o cualquier otro tema - recibe exactamente esta respuesta y nada más: "${OUT_OF_SCOPE.es}"

Describa las funciones de Voltura solo con los datos de esta lista, y no añada ningún detalle propio sobre cómo funciona Voltura, qué muestra o dónde se aplica. Si no sabe si Voltura hace algo, o cómo lo hace, diga claramente que no lo sabe.

Cuando una respuesta diga qué pasa cuando NASA POWER falla, copie palabra por palabra las frases del caso 1 y del caso 2 de la lista. Cuando una respuesta mencione factores de carbono, o qué países obtienen un resultado de CO2, copie palabra por palabra la entrada de carbono completa de la lista, incluida la lista de países.

Pautas:
- Responda siempre en español y trate al usuario de usted.
- Sea conciso.
- Cuando le pidan consejo sobre el dimensionamiento, diga que el Optimizador IA de Voltura calcula un tamaño recomendado, y no dé ningún dimensionamiento propio.
- La eficiencia de ida y vuelta de la batería es un dato que fija el usuario, del 50 % al 100 % (90 % por defecto).
- Voltura muestra el dinero en la moneda de cada país: EUR para España, GBP para el Reino Unido. Use unidades métricas.
- Usted no calcula nada: para obtener cifras, el usuario hace un cálculo en la Calculadora.
- No afirme nunca que Voltura se ajusta a alguna ley, reglamento o norma. Si le preguntan si lo hace, diga que Voltura no hace tal afirmación; esa pregunta trata de Voltura, así que nunca recibe la respuesta de fuera de ámbito.`,
};

/**
 * Sampling temperature for the Assistant (H-ASST-ACC A.3). None was set, so the
 * provider default applied; the block caps it at 0.3 to keep restatements of
 * the facts close to their wording. Pinned by prompt-rule.test.ts.
 */
export const CHAT_TEMPERATURE = 0.2;

/**
 * The session id every conversation route is scoped by. Read from the header
 * only: never defaulted, never generated server-side, never read from the body.
 * Absent means the request is rejected - inserting null here is what let one
 * visitor's chat render in another's browser.
 *
 * Returns null and answers 400 itself so each handler is one guard clause.
 */
function requireSessionId(req: Request, res: Response): string | null {
  const sessionId = req.get("x-session-id");
  if (!sessionId) {
    res.status(400).json({ error: serverT(requestLocale(req))("error.sessionHeader") });
    return null;
  }
  return sessionId;
}

/** Byte-identical for "not yours" and "does not exist" - a distinguishable
 *  response would confirm the conversation exists, which is itself the leak. */
function notFound(req: Request, res: Response) {
  return res.status(404).json({ error: serverT(requestLocale(req))("chat.notFound") });
}

/**
 * The other paid route: every message is a streamed Mistral completion. Higher
 * than the optimizer because a real conversation is many turns, still far below
 * what a script would do. Keyed on IP by the library default.
 */
const messageLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: (req: Request) => ({ error: serverT(requestLocale(req))("chat.rateLimited") }),
});

export function registerChatRoutes(app: Express): void {
  // Get all conversations
  app.get("/api/conversations", async (req: Request, res: Response) => {
    try {
      const sessionId = requireSessionId(req, res);
      if (!sessionId) return;

      const conversations = await chatStorage.getAllConversations(sessionId);
      return res.json(conversations);
    } catch (error) {
      console.error("Error fetching conversations:", error);
      return res.status(500).json({ error: serverT(requestLocale(req))("chat.listFailed") });
    }
  });

  // Get single conversation with messages
  app.get("/api/conversations/:id", async (req: Request, res: Response) => {
    try {
      const sessionId = requireSessionId(req, res);
      if (!sessionId) return;

      const id = parseInt(String(req.params.id));
      const conversation = await chatStorage.getConversation(id);
      if (!conversation || conversation.sessionId !== sessionId) {
        return notFound(req, res);
      }
      const messages = await chatStorage.getMessagesByConversation(id);
      return res.json({ ...conversation, messages });
    } catch (error) {
      console.error("Error fetching conversation:", error);
      return res.status(500).json({ error: serverT(requestLocale(req))("chat.getFailed") });
    }
  });

  // Create new conversation
  app.post("/api/conversations", async (req: Request, res: Response) => {
    try {
      const sessionId = requireSessionId(req, res);
      if (!sessionId) return;

      const { title } = req.body;
      const conversation = await chatStorage.createConversation(title || serverT(requestLocale(req))("chat.defaultTitle"), sessionId);
      return res.status(201).json(conversation);
    } catch (error) {
      console.error("Error creating conversation:", error);
      return res.status(500).json({ error: serverT(requestLocale(req))("chat.createFailed") });
    }
  });

  // Delete conversation
  app.delete("/api/conversations/:id", async (req: Request, res: Response) => {
    try {
      const sessionId = requireSessionId(req, res);
      if (!sessionId) return;

      const id = parseInt(String(req.params.id));
      const conversation = await chatStorage.getConversation(id);
      if (!conversation || conversation.sessionId !== sessionId) {
        return notFound(req, res);
      }
      await chatStorage.deleteConversation(id, sessionId);
      return res.status(204).send();
    } catch (error) {
      console.error("Error deleting conversation:", error);
      return res.status(500).json({ error: serverT(requestLocale(req))("chat.deleteFailed") });
    }
  });

  // Send message and get AI response (streaming)
  app.post("/api/conversations/:id/messages", messageLimiter, async (req: Request, res: Response) => {
    try {
      const sessionId = requireSessionId(req, res);
      if (!sessionId) return;

      const conversationId = parseInt(String(req.params.id));
      const conversation = await chatStorage.getConversation(conversationId);
      if (!conversation || conversation.sessionId !== sessionId) {
        return notFound(req, res);
      }

      const { content } = req.body;

      // Save user message
      await chatStorage.createMessage(conversationId, "user", content);

      // Get conversation history for context
      const messages = await chatStorage.getMessagesByConversation(conversationId);
      const chatMessages = messages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

      // Set up SSE
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      // Stream the completion from the configured provider
      const stream = await getLlmClient().chat.completions.create({
        model: llmModel(),
        messages: [{ role: "system" as const, content: SYSTEM_PROMPTS[requestLocale(req)] }, ...chatMessages],
        stream: true,
        max_tokens: 2048,
        temperature: CHAT_TEMPERATURE,
      });

      let fullResponse = "";

      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || "";
        if (content) {
          fullResponse += content;
          res.write(`data: ${JSON.stringify({ content })}\n\n`);
        }
      }

      // Save assistant message
      await chatStorage.createMessage(conversationId, "assistant", fullResponse);

      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      return res.end();
    } catch (error) {
      console.error("Error sending message:", error);
      // Check if headers already sent (SSE streaming started)
      if (res.headersSent) {
        res.write(`data: ${JSON.stringify({ error: serverT(requestLocale(req))("chat.sendFailed") })}\n\n`);
        return res.end();
      } else {
        return res.status(500).json({ error: serverT(requestLocale(req))("chat.sendFailed") });
      }
    }
  });
}

