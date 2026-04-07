/**
 * Supabase DB layer for the iMessage Agent.
 *
 * Drop-in parallel to memory.ts — same shape, Supabase-backed.
 * Designed for multi-user: every operation scopes to the authenticated user's id.
 *
 * Usage:
 *   const db = new AgentDB(supabaseUrl, supabaseAnonKey, userId)
 *   const contacts = await db.getContact('+13104296285')
 *
 * Migration: run src/imessage/schema.sql in Supabase SQL editor first.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// ─── Types matching schema.sql ─────────────────────────────────────────────────

export interface DBUser {
  id: string;
  phone: string | null;
  email: string | null;
  display_name: string;
  persona: string | null;
  own_handles: string[];
  style_json: Record<string, unknown>;
  config_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface DBContact {
  id: string;
  user_id: string;
  handle: string;
  display_name: string | null;
  relationship: string | null;
  vibe: string | null;
  auto_reply_ok: boolean;
  always_skip: boolean;
  skip_reason: string | null;
  last_contacted_at: string | null;
  last_replied_at: string | null;
  first_contact_at: string | null;
  sent_count: number;
  received_count: number;
  trust_score: number;
  relationship_score: number;
  notes: string[];
  is_group: boolean;
  group_name: string | null;
  conversation_mode: "auto" | "gpt_chat" | "task" | "off";
  preferred_format: "brief" | "detailed" | "list" | "narrative";
  research_cache: Array<{ query: string; result: string; fetched_at: string }>;
  clay_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface DBMessage {
  id: string;
  user_id: string;
  contact_id: string | null;
  imessage_guid: string | null;
  chat_id: string | null;
  sender_handle: string;
  is_from_me: boolean;
  text: string | null;
  body_type: string;
  sent_at: string;
  intent_type: string | null;
  intent_confidence: number | null;
  intent_payload: Record<string, unknown>;
  reply_to_guid: string | null;
  thread_id: string | null;
  is_reaction: boolean;
  reaction_type: string | null;
  is_group_chat: boolean;
  processed_at: string | null;
  created_at: string;
}

export interface DBConversationSession {
  id: string;
  user_id: string;
  contact_id: string;
  mode: "gpt_chat" | "task" | "support" | "auto";
  system_prompt: string | null;
  message_history: Array<{
    role: "user" | "assistant";
    content: string;
    sent_at: string;
    intent_type?: string;
  }>;
  context_summary: string | null;
  turn_count: number;
  preferences: {
    format?: "list" | "narrative" | "brief";
    tone?: "casual" | "formal" | "warm";
    emoji?: boolean;
    length?: "short" | "medium" | "long";
  };
  last_active_at: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface DBPendingQuestion {
  id: string;
  user_id: string;
  contact_id: string | null;
  handle: string;
  message_preview: string | null;
  questions: string[];
  draft_reply: string | null;
  asked_at: string;
  answered: boolean;
  answer: string | null;
  answered_at: string | null;
}

export interface DBSentEntry {
  id: string;
  user_id: string;
  contact_id: string | null;
  to_handle: string;
  message: string;
  sent_at: string;
  context: string | null;
  dry_run: boolean;
  conversation_mode: boolean;
  session_id: string | null;
  intent_triggered: string | null;
}

export interface DBLearning {
  id: string;
  user_id: string;
  content: string;
  source: "manual" | "inference" | "style_analysis" | "web_research";
  confidence: number;
  created_at: string;
}

// ─── AgentDB class ─────────────────────────────────────────────────────────────

export class AgentDB {
  private supabase: SupabaseClient;
  private userId: string;

  constructor(url: string, key: string, userId: string) {
    this.supabase = createClient(url, key);
    this.userId = userId;
  }

  // ─── User ───────────────────────────────────────────────────────────────────

  async getUser(): Promise<DBUser | null> {
    const { data, error } = await this.supabase
      .from("agent_users")
      .select("*")
      .eq("id", this.userId)
      .single();
    if (error) return null;
    return data as DBUser;
  }

  async upsertUser(
    fields: Partial<Omit<DBUser, "id" | "created_at" | "updated_at">>,
  ): Promise<void> {
    const { error } = await this.supabase
      .from("agent_users")
      .upsert({ id: this.userId, ...fields }, { onConflict: "id" });
    if (error) throw new Error(`[db] upsertUser: ${error.message}`);
  }

  // ─── Contacts ───────────────────────────────────────────────────────────────

  async getContact(handle: string): Promise<DBContact | null> {
    const { data, error } = await this.supabase
      .from("contacts")
      .select("*")
      .eq("user_id", this.userId)
      .eq("handle", handle)
      .single();
    if (error) return null;
    return data as DBContact;
  }

  async getOrCreateContact(handle: string): Promise<DBContact> {
    const existing = await this.getContact(handle);
    if (existing) return existing;

    const { data, error } = await this.supabase
      .from("contacts")
      .insert({
        user_id: this.userId,
        handle,
        auto_reply_ok: false,
        always_skip: false,
        sent_count: 0,
        received_count: 0,
        trust_score: 0,
        relationship_score: 0,
        notes: [],
        research_cache: [],
      })
      .select()
      .single();
    if (error) throw new Error(`[db] getOrCreateContact: ${error.message}`);
    return data as DBContact;
  }

  async updateContact(
    handle: string,
    fields: Partial<DBContact>,
  ): Promise<void> {
    const { error } = await this.supabase
      .from("contacts")
      .update(fields)
      .eq("user_id", this.userId)
      .eq("handle", handle);
    if (error) throw new Error(`[db] updateContact: ${error.message}`);
  }

  async markAlwaysSkip(handle: string, reason: string): Promise<void> {
    await this.updateContact(handle, {
      always_skip: true,
      skip_reason: reason,
    });
  }

  async incrementTrustScore(handle: string, delta = 0.05): Promise<void> {
    const contact = await this.getContact(handle);
    if (!contact) return;
    const next = Math.min(1, contact.trust_score + delta);
    await this.updateContact(handle, { trust_score: next });
  }

  async setResearchCache(
    handle: string,
    query: string,
    result: string,
  ): Promise<void> {
    const contact = await this.getOrCreateContact(handle);
    const cache = (contact.research_cache ?? []).filter(
      (c) => c.query !== query,
    );
    cache.push({ query, result, fetched_at: new Date().toISOString() });
    const trimmed = cache.slice(-10); // cap at 10
    await this.updateContact(handle, { research_cache: trimmed });
  }

  async getCachedResearch(
    handle: string,
    query: string,
    maxAgeHours = 72,
  ): Promise<string | null> {
    const contact = await this.getContact(handle);
    if (!contact?.research_cache?.length) return null;
    const hit = contact.research_cache.find((c) => c.query === query);
    if (!hit) return null;
    const age = Date.now() - new Date(hit.fetched_at).getTime();
    if (age > maxAgeHours * 3_600_000) return null;
    return hit.result;
  }

  async listContacts(opts?: {
    autoReplyOnly?: boolean;
    skipSkipped?: boolean;
  }): Promise<DBContact[]> {
    let q = this.supabase
      .from("contacts")
      .select("*")
      .eq("user_id", this.userId);
    if (opts?.autoReplyOnly) q = q.eq("auto_reply_ok", true);
    if (opts?.skipSkipped) q = q.eq("always_skip", false);
    const { data, error } = await q.order("last_contacted_at", {
      ascending: false,
    });
    if (error) throw new Error(`[db] listContacts: ${error.message}`);
    return (data ?? []) as DBContact[];
  }

  // ─── Messages ───────────────────────────────────────────────────────────────

  async insertMessage(
    msg: Omit<DBMessage, "id" | "created_at">,
  ): Promise<DBMessage> {
    const { data, error } = await this.supabase
      .from("messages")
      .insert({ ...msg, user_id: this.userId })
      .select()
      .single();
    if (error) throw new Error(`[db] insertMessage: ${error.message}`);
    return data as DBMessage;
  }

  async upsertMessage(
    msg: Omit<DBMessage, "id" | "created_at">,
  ): Promise<DBMessage> {
    const { data, error } = await this.supabase
      .from("messages")
      .upsert({ ...msg, user_id: this.userId }, { onConflict: "imessage_guid" })
      .select()
      .single();
    if (error) throw new Error(`[db] upsertMessage: ${error.message}`);
    return data as DBMessage;
  }

  async getUnprocessedMessages(limit = 100): Promise<DBMessage[]> {
    const { data, error } = await this.supabase
      .from("messages")
      .select("*")
      .eq("user_id", this.userId)
      .is("processed_at", null)
      .eq("is_from_me", false)
      .order("sent_at", { ascending: true })
      .limit(limit);
    if (error) throw new Error(`[db] getUnprocessedMessages: ${error.message}`);
    return (data ?? []) as DBMessage[];
  }

  async markMessageProcessed(messageId: string): Promise<void> {
    const { error } = await this.supabase
      .from("messages")
      .update({ processed_at: new Date().toISOString() })
      .eq("id", messageId)
      .eq("user_id", this.userId);
    if (error) throw new Error(`[db] markMessageProcessed: ${error.message}`);
  }

  async updateMessageIntent(
    messageId: string,
    intentType: string,
    confidence: number,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const { error } = await this.supabase
      .from("messages")
      .update({
        intent_type: intentType,
        intent_confidence: confidence,
        intent_payload: payload,
      })
      .eq("id", messageId)
      .eq("user_id", this.userId);
    if (error) throw new Error(`[db] updateMessageIntent: ${error.message}`);
  }

  async getRecentThread(contactId: string, limit = 20): Promise<DBMessage[]> {
    const { data, error } = await this.supabase
      .from("messages")
      .select("*")
      .eq("user_id", this.userId)
      .eq("contact_id", contactId)
      .order("sent_at", { ascending: false })
      .limit(limit);
    if (error) throw new Error(`[db] getRecentThread: ${error.message}`);
    return ((data ?? []) as DBMessage[]).reverse();
  }

  // ─── Intent Events ──────────────────────────────────────────────────────────

  async insertIntentEvent(event: {
    message_id?: string;
    contact_id?: string;
    intent_type: string;
    confidence: number;
    context?: string;
    raw_text?: string;
    action_taken?: string;
    action_result?: Record<string, unknown>;
  }): Promise<void> {
    const { error } = await this.supabase
      .from("intent_events")
      .insert({ ...event, user_id: this.userId });
    if (error) throw new Error(`[db] insertIntentEvent: ${error.message}`);
  }

  // ─── Conversation Sessions ──────────────────────────────────────────────────

  async getSession(contactId: string): Promise<DBConversationSession | null> {
    const { data, error } = await this.supabase
      .from("conversation_sessions")
      .select("*")
      .eq("user_id", this.userId)
      .eq("contact_id", contactId)
      .single();
    if (error) return null;
    return data as DBConversationSession;
  }

  async upsertSession(
    contactId: string,
    fields: Partial<
      Omit<
        DBConversationSession,
        "id" | "user_id" | "contact_id" | "created_at"
      >
    >,
  ): Promise<DBConversationSession> {
    const existing = await this.getSession(contactId);
    if (existing) {
      const { data, error } = await this.supabase
        .from("conversation_sessions")
        .update(fields)
        .eq("id", existing.id)
        .select()
        .single();
      if (error) throw new Error(`[db] upsertSession update: ${error.message}`);
      return data as DBConversationSession;
    }
    const { data, error } = await this.supabase
      .from("conversation_sessions")
      .insert({
        user_id: this.userId,
        contact_id: contactId,
        is_active: true,
        turn_count: 0,
        message_history: [],
        preferences: {},
        ...fields,
      })
      .select()
      .single();
    if (error) throw new Error(`[db] upsertSession insert: ${error.message}`);
    return data as DBConversationSession;
  }

  async appendToSession(
    contactId: string,
    role: "user" | "assistant",
    content: string,
    intentType?: string,
  ): Promise<void> {
    const session = await this.getSession(contactId);
    const entry = {
      role,
      content,
      sent_at: new Date().toISOString(),
      ...(intentType ? { intent_type: intentType } : {}),
    };

    if (!session) {
      await this.upsertSession(contactId, {
        message_history: [entry],
        turn_count: 1,
        last_active_at: new Date().toISOString(),
      });
      return;
    }

    // Keep rolling window of last 40 turns (summarize older turns separately)
    const history = [...session.message_history, entry].slice(-40);

    const { error } = await this.supabase
      .from("conversation_sessions")
      .update({
        message_history: history,
        turn_count: session.turn_count + 1,
        last_active_at: new Date().toISOString(),
      })
      .eq("id", session.id);
    if (error) throw new Error(`[db] appendToSession: ${error.message}`);
  }

  async setSessionPreferences(
    contactId: string,
    prefs: DBConversationSession["preferences"],
  ): Promise<void> {
    const session = await this.getSession(contactId);
    if (!session) {
      await this.upsertSession(contactId, { preferences: prefs });
      return;
    }
    const merged = { ...session.preferences, ...prefs };
    const { error } = await this.supabase
      .from("conversation_sessions")
      .update({ preferences: merged })
      .eq("id", session.id);
    if (error) throw new Error(`[db] setSessionPreferences: ${error.message}`);
  }

  // ─── Pending Questions ──────────────────────────────────────────────────────

  async addPendingQuestion(
    handle: string,
    messagePreview: string,
    question: string,
    draftReply?: string,
  ): Promise<string> {
    const contact = await this.getContact(handle);

    const { data: existing } = await this.supabase
      .from("pending_questions")
      .select("*")
      .eq("user_id", this.userId)
      .eq("handle", handle)
      .eq("answered", false)
      .single();

    if (existing) {
      const qs = existing.questions ?? [];
      if (!qs.includes(question)) qs.push(question);
      await this.supabase
        .from("pending_questions")
        .update({
          questions: qs,
          ...(draftReply && !existing.draft_reply
            ? { draft_reply: draftReply }
            : {}),
        })
        .eq("id", existing.id);
      return existing.id;
    }

    const id = `q-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
    const { error } = await this.supabase.from("pending_questions").insert({
      id,
      user_id: this.userId,
      contact_id: contact?.id ?? null,
      handle,
      message_preview: messagePreview || "[attachment]",
      questions: [question],
      draft_reply: draftReply ?? null,
      asked_at: new Date().toISOString(),
      answered: false,
    });
    if (error) throw new Error(`[db] addPendingQuestion: ${error.message}`);
    return id;
  }

  async getUnansweredQuestions(limit = 20): Promise<DBPendingQuestion[]> {
    const { data, error } = await this.supabase
      .from("pending_questions")
      .select("*")
      .eq("user_id", this.userId)
      .eq("answered", false)
      .order("asked_at", { ascending: true })
      .limit(limit);
    if (error) throw new Error(`[db] getUnansweredQuestions: ${error.message}`);
    return (data ?? []) as DBPendingQuestion[];
  }

  async answerQuestion(id: string, answer: string): Promise<void> {
    const { error } = await this.supabase
      .from("pending_questions")
      .update({ answered: true, answer, answered_at: new Date().toISOString() })
      .eq("id", id)
      .eq("user_id", this.userId);
    if (error) throw new Error(`[db] answerQuestion: ${error.message}`);
  }

  // ─── Sent Log ───────────────────────────────────────────────────────────────

  async recordSent(opts: {
    toHandle: string;
    message: string;
    context?: string;
    dryRun?: boolean;
    conversationMode?: boolean;
    sessionId?: string;
    intentTriggered?: string;
    contactId?: string;
  }): Promise<void> {
    const id = `s-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const { error } = await this.supabase.from("sent_log").insert({
      id,
      user_id: this.userId,
      contact_id: opts.contactId ?? null,
      to_handle: opts.toHandle,
      message: opts.message,
      sent_at: new Date().toISOString(),
      context: opts.context ?? null,
      dry_run: opts.dryRun ?? false,
      conversation_mode: opts.conversationMode ?? false,
      session_id: opts.sessionId ?? null,
      intent_triggered: opts.intentTriggered ?? null,
    });
    if (error) throw new Error(`[db] recordSent: ${error.message}`);

    if (!opts.dryRun && opts.contactId) {
      // Bump sent_count + trust
      const contact = await this.getContact(opts.toHandle);
      if (contact) {
        await this.updateContact(opts.toHandle, {
          sent_count: contact.sent_count + 1,
          trust_score: Math.min(1, contact.trust_score + 0.05),
          last_replied_at: new Date().toISOString(),
        });
      }
    }
  }

  // ─── Learnings ──────────────────────────────────────────────────────────────

  async addLearning(
    content: string,
    source: DBLearning["source"] = "inference",
    confidence = 1.0,
  ): Promise<void> {
    if (content.trim().length < 10) return;

    // Dedup: fetch recent learnings and check 60-char prefix
    const { data } = await this.supabase
      .from("agent_learnings")
      .select("content")
      .eq("user_id", this.userId)
      .order("created_at", { ascending: false })
      .limit(100);

    const lower = content.toLowerCase().trim();
    const isDuplicate = (data ?? []).some((l: { content: string }) => {
      const existing = l.content.toLowerCase();
      const prefixLen = Math.min(
        60,
        Math.floor(Math.min(lower.length, existing.length) * 0.6),
      );
      return existing.slice(0, prefixLen) === lower.slice(0, prefixLen);
    });

    if (isDuplicate) return;

    const { error } = await this.supabase
      .from("agent_learnings")
      .insert({ user_id: this.userId, content, source, confidence });
    if (error) throw new Error(`[db] addLearning: ${error.message}`);
  }

  async getLearnings(limit = 60): Promise<string[]> {
    const { data, error } = await this.supabase
      .from("agent_learnings")
      .select("content")
      .eq("user_id", this.userId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) return [];
    return (data ?? []).map((l: { content: string }) => l.content);
  }

  // ─── Stats ──────────────────────────────────────────────────────────────────

  async getStats(): Promise<{
    totalSent: number;
    totalDryRun: number;
    totalSkipped: number;
  }> {
    const [{ count: sent }, { count: dry }, { count: skipped }] =
      await Promise.all([
        this.supabase
          .from("sent_log")
          .select("*", { count: "exact", head: true })
          .eq("user_id", this.userId)
          .eq("dry_run", false),
        this.supabase
          .from("sent_log")
          .select("*", { count: "exact", head: true })
          .eq("user_id", this.userId)
          .eq("dry_run", true),
        this.supabase
          .from("contacts")
          .select("*", { count: "exact", head: true })
          .eq("user_id", this.userId)
          .eq("always_skip", true),
      ]);
    return {
      totalSent: sent ?? 0,
      totalDryRun: dry ?? 0,
      totalSkipped: skipped ?? 0,
    };
  }
}

// ─── Factory: build from env ───────────────────────────────────────────────────

export function createAgentDB(userId: string): AgentDB {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_ANON_KEY;
  if (!url || !key)
    throw new Error("[db] SUPABASE_URL and SUPABASE_SERVICE_KEY are required");
  return new AgentDB(url, key, userId);
}
