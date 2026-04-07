/**
 * Conversational AI Engine
 *
 * GPT-level conversational quality over iMessage.
 * What makes it addicting:
 *   - Remembers everything said in the thread (rolling 40-turn window)
 *   - Adapts format to what the person prefers (list, brief, detailed, narrative)
 *   - Ends every response with a follow-up question that keeps the thread going
 *   - Matches energy: casual = casual back, excited = excited back
 *   - Genuinely useful: answers real questions, helps with real problems
 *   - Personalized system prompt per contact (relationship, vibe, topics)
 *   - Rolling context summary so nothing important gets lost
 *
 * Not a chatbot. Feels like texting a smart friend who actually knows you.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { DBContact, DBConversationSession, AgentDB } from "./db.ts";
import { type Intent, classifyIntent } from "./intent.ts";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface ConvoMessage {
  role: "user" | "assistant";
  content: string;
  sent_at: string;
  intent_type?: string;
}

export interface ConvoResponse {
  text: string;
  session_id: string;
  turn_count: number;
  format_used: string;
  ended: boolean; // true if farewell was detected
}

export interface ConvoContext {
  user: {
    display_name: string;
    persona: string;
    own_handles: string[];
  };
  contact: DBContact;
  session: DBConversationSession;
  recentRawMessages?: Array<{
    text: string;
    is_from_me: boolean;
    sent_at: string;
  }>;
}

// ─── Format templates ──────────────────────────────────────────────────────────

const FORMAT_INSTRUCTIONS: Record<string, string> = {
  brief: `Keep responses SHORT. 1-3 sentences max. No fluff. Get to the point immediately. End with one punchy follow-up question.`,
  list: `Use bullet points or numbered lists when presenting multiple items. Format: short lead sentence, then bullets. End with a short question.`,
  detailed: `Give thorough, substantive responses. Use paragraphs. Include context, nuance, and examples. End with a thoughtful follow-up question.`,
  narrative: `Write in a natural, flowing conversational style. Like a friend texting a story. Warm, personal, specific. End with a genuine question.`,
};

// ─── System prompt builder ─────────────────────────────────────────────────────

function buildSystemPrompt(ctx: ConvoContext): string {
  const { user, contact, session } = ctx;
  const format = session.preferences?.format ?? "brief";
  const tone = session.preferences?.tone ?? "casual";
  const emojiOk = session.preferences?.emoji ?? false;
  const lengthPref = session.preferences?.length ?? "short";

  const formatInstruction =
    FORMAT_INSTRUCTIONS[format] ?? FORMAT_INSTRUCTIONS.brief;
  const emojiInstruction = emojiOk
    ? "You can use occasional emoji to match the tone."
    : "Do NOT use emoji.";

  const toneInstruction =
    {
      casual:
        "Tone: casual, direct, like a smart friend texting. Lowercase is fine. No corporate speak.",
      formal: "Tone: polished and professional, but still warm and personal.",
      warm: "Tone: warm, encouraging, genuine. Like a mentor or close friend.",
    }[tone] ?? "Tone: casual and direct.";

  const contactContext = [
    contact.display_name
      ? `You're texting with ${contact.display_name}.`
      : null,
    contact.relationship ? `Relationship: ${contact.relationship}.` : null,
    contact.vibe ? `Their vibe: ${contact.vibe}` : null,
    contact.notes?.length
      ? `Notes about them: ${contact.notes.join(". ")}`
      : null,
  ]
    .filter(Boolean)
    .join(" ");

  const userContext = user.persona
    ? `You are texting on behalf of ${user.display_name}. About them: ${user.persona}`
    : `You are texting on behalf of ${user.display_name}.`;

  const contextSummary = session.context_summary
    ? `\nContext from earlier in this conversation: ${session.context_summary}`
    : "";

  return [
    userContext,
    contactContext,
    ``,
    `FORMAT: ${formatInstruction}`,
    `TONE: ${toneInstruction}`,
    emojiInstruction,
    `LENGTH: Aim for ${lengthPref} responses.`,
    ``,
    `RULES:`,
    `- Never mention you are an AI or assistant.`,
    `- Never say "I" as if you're Claude. You ARE ${user.display_name} in this context.`,
    `- Always end with a follow-up question that invites a response — this keeps the conversation alive.`,
    `- If they ask something you genuinely don't know, say so briefly and redirect with a question.`,
    `- Match their energy: if they're excited, match it. If they're short, be short back.`,
    `- Never lecture or moralize.`,
    `- Be genuinely curious about them.`,
    contextSummary,
  ]
    .filter((l) => l !== null)
    .join("\n");
}

// ─── Context summarizer ────────────────────────────────────────────────────────

async function summarizeOlderTurns(
  client: Anthropic,
  history: ConvoMessage[],
  existingSummary: string | null,
): Promise<string> {
  const historyText = history
    .map((m) => `${m.role === "user" ? "Them" : "Me"}: ${m.content}`)
    .join("\n");

  const prompt = existingSummary
    ? `Previous summary: ${existingSummary}\n\nNew messages:\n${historyText}\n\nUpdate the summary in 2-3 sentences. Keep what matters, drop what's stale.`
    : `Summarize this conversation in 2-3 sentences. Focus on topics covered, decisions made, and anything the other person wants or needs.\n\n${historyText}`;

  const msg = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 200,
    messages: [{ role: "user", content: prompt }],
  });

  return (msg.content[0] as { text: string }).text.trim();
}

// ─── Main reply generator ──────────────────────────────────────────────────────

export async function generateConvoReply(
  incomingText: string,
  ctx: ConvoContext,
  db: AgentDB,
  anthropicKey: string,
): Promise<ConvoResponse> {
  const client = new Anthropic({ apiKey: anthropicKey });
  const { contact, session } = ctx;
  const contactId = contact.id;

  // Classify the incoming message
  const intent = classifyIntent(incomingText);

  // Detect preference updates inline ("send me bullet points")
  if (intent.type === "preference" && intent.payload.format) {
    const formatMap: Record<string, string> = {
      list: "list",
      brief: "brief",
      detailed: "detailed",
      narrative: "narrative",
      no_emoji: "brief",
      emoji: "brief",
    };
    const newFormat =
      formatMap[intent.payload.format] ?? session.preferences?.format;
    await db.setSessionPreferences(contactId, {
      ...session.preferences,
      format: newFormat as "list" | "brief" | "detailed" | "narrative",
      emoji:
        intent.payload.format === "emoji"
          ? true
          : intent.payload.format === "no_emoji"
            ? false
            : session.preferences?.emoji,
    });
    // Reload session with new prefs
    const updated = await db.getSession(contactId);
    if (updated) ctx = { ...ctx, session: updated };
  }

  // Build message history for the API call
  let history = [...session.message_history] as ConvoMessage[];

  // If history is getting long, summarize older turns (> 30 turns)
  if (history.length > 30) {
    const toSummarize = history.slice(0, -20);
    const recent = history.slice(-20);
    const summary = await summarizeOlderTurns(
      client,
      toSummarize,
      session.context_summary ?? null,
    );
    // Persist the summary
    await db.upsertSession(contactId, { context_summary: summary });
    history = recent;
  }

  // Append the new incoming message
  history.push({
    role: "user",
    content: incomingText,
    sent_at: new Date().toISOString(),
    intent_type: intent.type,
  });

  // Build the API messages array
  const apiMessages: Anthropic.MessageParam[] = history.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  // Generate reply
  const systemPrompt = buildSystemPrompt(ctx);
  const model = "claude-sonnet-4-6";

  const response = await client.messages.create({
    model,
    max_tokens: lengthToTokens(ctx.session.preferences?.length ?? "short"),
    system: systemPrompt,
    messages: apiMessages,
  });

  const replyText = (response.content[0] as { text: string }).text.trim();

  // Persist to DB
  await db.appendToSession(contactId, "user", incomingText, intent.type);
  await db.appendToSession(contactId, "assistant", replyText);

  const updatedSession = await db.getSession(contactId);

  return {
    text: replyText,
    session_id: session.id,
    turn_count: updatedSession?.turn_count ?? session.turn_count + 1,
    format_used: ctx.session.preferences?.format ?? "brief",
    ended: intent.type === "farewell",
  };
}

// ─── Proactive message generator ──────────────────────────────────────────────

/**
 * Generates the first message to a contact — used for outreach mode.
 * Pulls from Clay/research context to make it feel personal and specific.
 */
export async function generateOutreach(
  contact: DBContact,
  user: { display_name: string; persona: string },
  researchContext: string,
  anthropicKey: string,
  format: "cold" | "warm" | "reactivation" = "warm",
): Promise<string> {
  const client = new Anthropic({ apiKey: anthropicKey });

  const OUTREACH_PROMPTS = {
    cold: `Write a first text to ${contact.display_name ?? contact.handle}. It should feel genuine and direct — not salesy. Short. One specific observation or compliment based on what you know about them, then one clear reason you're reaching out.`,
    warm: `You know ${contact.display_name ?? contact.handle} but haven't talked in a while. Write a short, casual check-in that feels warm and personal. Reference something specific about them if possible. End with a question.`,
    reactivation: `${contact.display_name ?? contact.handle} hasn't responded in a while. Write a short, non-pushy follow-up that acknowledges the gap and gives them an easy way to re-engage.`,
  };

  const system = [
    `You are ${user.display_name}. ${user.persona}`,
    `Keep it to 1-3 sentences max. No emoji. Lowercase is fine. Sound like a human, not a startup founder writing an outreach template.`,
    `Context about this person: ${researchContext || "No additional context."}`,
    contact.vibe ? `Their vibe: ${contact.vibe}` : null,
    contact.notes?.length ? `Notes: ${contact.notes.join(". ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const msg = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 120,
    system,
    messages: [{ role: "user", content: OUTREACH_PROMPTS[format] }],
  });

  return (msg.content[0] as { text: string }).text.trim();
}

// ─── Reply quality check ───────────────────────────────────────────────────────

/**
 * Quick sanity check before sending — catches AI-sounding phrases.
 * Returns { ok: true } or { ok: false, reason: string }.
 */
export function checkReplyQuality(text: string): {
  ok: boolean;
  reason?: string;
} {
  const AI_TELLS = [
    /\bI'm (an AI|a language model|Claude|an assistant)\b/i,
    /\bAs an AI\b/i,
    /\bI cannot assist with\b/i,
    /\bI don'?t have (the ability|access|real.?time)\b/i,
    /certainly!/i,
    /absolutely!/i,
    /great question/i,
    /I hope this helps/i,
    /please let me know if/i,
    /feel free to (ask|reach out)/i,
    /I'd be happy to/i,
  ];

  for (const pattern of AI_TELLS) {
    if (pattern.test(text)) {
      return { ok: false, reason: `sounds like AI: "${text.slice(0, 50)}..."` };
    }
  }

  if (text.length > 600) {
    return {
      ok: false,
      reason: `too long for iMessage (${text.length} chars)`,
    };
  }

  return { ok: true };
}

// ─── Session bootstrapper ──────────────────────────────────────────────────────

/**
 * Gets or creates a conversation session for a contact.
 * Sets smart defaults based on contact's relationship and vibe.
 */
export async function getOrBootstrapSession(
  contact: DBContact,
  userId: string,
  db: AgentDB,
): Promise<DBConversationSession> {
  const existing = await db.getSession(contact.id);
  if (existing?.is_active) return existing;

  // Smart defaults based on relationship
  const defaultFormat: DBConversationSession["preferences"]["format"] = (() => {
    if (contact.relationship === "investor") return "brief";
    if (contact.relationship === "bma") return "brief";
    if (contact.relationship === "friend") return "narrative";
    if (contact.relationship === "professor") return "detailed";
    return "brief";
  })();

  return db.upsertSession(contact.id, {
    mode: "gpt_chat",
    is_active: true,
    turn_count: 0,
    message_history: [],
    preferences: {
      format: defaultFormat,
      tone:
        contact.relationship === "investor" || contact.relationship === "bma"
          ? "formal"
          : "casual",
      emoji: false,
      length: "short",
    },
  });
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function lengthToTokens(length: string): number {
  return { short: 200, medium: 400, long: 700 }[length] ?? 200;
}
