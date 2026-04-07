#!/usr/bin/env bun
/**
 * Caleb's iMessage Agent — v6
 *
 * Modes:
 *   scan    → inbox stats + name-resolved top unreads (no API needed)
 *   inbox   → full name-resolved inbox (no API needed)
 *   run     → triage + auto-reply (Anthropic preferred, Ollama fallback)
 *   style   → learn Caleb's texting style from history
 *   answer  → answer pending question: --id q-xxx --answer "yo whats up"
 *   send    → send a manual message: --handle +13104296285 --message "yo"
 *   clean   → wipe pending questions with bad/AI-revealing drafts
 *   skip    → permanently skip a contact: --handle +1xxx
 *   unskip  → remove a contact from always-skip: --handle +1xxx
 *   cancel  → cancel a pending question: --id q-xxx
 *   digest  → morning digest: pending questions + prospect gaps → Slack/stdout
 *   chat    → full thread view with Clay CRM profile: --handle +1xxx
 *
 * v6 changes:
 *   - contacts.ts: reads AddressBook sqlite directly, 1049 contacts, ~50ms load
 *   - senderName was ALWAYS null in SDK (hardcoded) — now resolved from AddressBook
 *   - Caleb's own number (+13104296285) filtered out of triage
 *   - preFilter no longer permanently marks linkedin/spam without confirmation
 *   - --mode answer sends the answer text directly if it looks like a real message
 *   - --mode send for manual one-off sends
 *   - All output shows real names (Sagar Tiwari, Sia Gupta, Porter Calva, etc.)
 *   - messagePreview shows "[media]" not "" for attachment-only convos
 *   - scan/inbox groups: known contacts first, then unknown
 *   - Contact count shown at startup
 */

import { createServer } from "node:http";
import { IMessageSDK } from "../../packages/photon-imessage-kit/src/index.ts";
import type { Message } from "../../packages/photon-imessage-kit/src/types/message.ts";
import {
  loadMemory,
  saveMemory,
  getOrCreateContact,
  normalizeHandle,
  markAlwaysSkip,
  recordSent,
  addPendingQuestion,
  getUnansweredQuestions,
  getCachedResearch,
  setCachedResearch,
  addLearning,
  type AgentMemory,
  type ContactProfile,
} from "./memory.ts";
import {
  research,
  buildResearchQuery,
  buildPerplexitySystem,
} from "./perplexity.ts";
import { lookupName, contactCount, loadContacts } from "./contacts.ts";
import {
  isBmaProspect,
  routeProspectReply,
  logInteraction,
  getClayProfile,
  buildDigestData,
  buildDigestBlocks,
  sendDigestToSlack,
  postSlack,
} from "./integrations.ts";
import { classifyIntent } from "./intent.ts";
import {
  generateConvoReply,
  checkReplyQuality,
  getOrBootstrapSession,
  type ConvoContext,
} from "./convo.ts";
import { createAgentDB, type AgentDB } from "./db.ts";

// ─── Args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const getFlag = (f: string): string | undefined => {
  const i = args.indexOf(f);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
};
const hasFlag = (f: string) => args.includes(f);

const mode = getFlag("--mode") ?? "scan";
const DRY_RUN = hasFlag("--dry-run");
const DEBUG = hasFlag("--debug");
const LIMIT = Math.max(1, parseInt(getFlag("--limit") ?? "50") || 50);

// ─── Models ────────────────────────────────────────────────────────────────────

const HAIKU = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-4-6";

const OLLAMA_URL = "http://localhost:11434";
let OLLAMA_MODEL = "llama3.2:latest";
let _provider = "ollama";
let _anthropic: any = null;
let _anthropicDead = false;
let _groq: any = null;
let _groqDead = false;
const GROQ_MODEL = process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile";

const API_TIMEOUT_MS = 20_000;
const OLLAMA_TIMEOUT_MS = 60_000;
const MAX_AUTO_SENDS = 25;
const MAX_REPLY_LEN = 280;

// Caleb's own handles — env vars allow changing without editing code
const CALEB_HANDLES = new Set([
  process.env.CALEB_PHONE ?? "+13104296285",
  process.env.CALEB_EMAIL ?? "calebnewtonusc@gmail.com",
]);

// ─── Init ──────────────────────────────────────────────────────────────────────

const sdk = new IMessageSDK({ debug: false });
const memory = loadMemory();
loadContacts(); // warm cache at startup — 50ms

// Optional Supabase DB — initialized only when env vars are present.
// Falls back to local memory.ts layer gracefully when not configured.
let db: AgentDB | null = null;
if (
  process.env.SUPABASE_URL &&
  process.env.SUPABASE_SERVICE_KEY &&
  process.env.AGENT_USER_ID
) {
  db = createAgentDB(process.env.AGENT_USER_ID);
  console.log("[db] Supabase layer active");
}

// ─── Name resolution ───────────────────────────────────────────────────────────

function getName(handle: string, contact?: ContactProfile): string {
  return contact?.displayName || lookupName(handle) || handle;
}

/** Sync looked-up name into contact profile so it persists */
function syncName(handle: string, contact: ContactProfile): void {
  if (!contact.displayName) {
    const name = lookupName(handle);
    if (name) contact.displayName = name;
  }
}

// ─── Pre-filter (no LLM needed) ────────────────────────────────────────────────

const OTP_PATTERNS = [
  /\b\d{4,8}\b.*(?:is your|verification|one.?time)/i,
  /(?:your|here is|use this).*(?:code|pin|otp).*\b\d{4,8}\b/i,
  /verification code[:：]\s*\d/i,
  /\bOTP\b|\bTOTP\b/,
];

// Only cold-outreach LinkedIn — not friends mentioning LinkedIn
const LINKEDIN_COLD = [
  /i(?:'d| would) love to connect.*linkedin/i,
  /saw your linkedin profile/i,
  /reaching out.*(?:via|on|through) linkedin/i,
  /connect with you on linkedin/i,
  /linkedin.*(?:opportunity|position|role|job|recruit)/i,
];
// LinkedIn cold outreach is permanent — don't re-process every run

const HARD_SPAM = [
  /unsubscribe/i,
  /REPLY STOP/i,
  /text stop to opt out/i,
  /this is an automated message/i,
  /amazon.*remote opportunities/i,
];

type PreFilterResult = {
  skip: true;
  reason: string;
  permanent: boolean;
} | null;

function preFilter(msgs: Message[]): PreFilterResult {
  if (!msgs.length) return { skip: true, reason: "empty", permanent: false };

  // Skip reactions entirely (Liked/Loved/etc) — never reply to these
  if (msgs.every((m) => m.isReaction))
    return { skip: true, reason: "reactions only", permanent: false };

  // Group chats — skip by default (can be overridden for specific groups later)
  if (msgs.some((m) => m.isGroupChat))
    return { skip: true, reason: "group chat", permanent: false };

  // Check each message independently to avoid false-positives from joining text across boundaries
  const texts = msgs.map((m) => m.text || "").filter(Boolean);
  const allText = texts.join("\n"); // newline keeps cross-message OTP patterns from matching

  if (texts.some((t) => OTP_PATTERNS.some((p) => p.test(t))))
    return { skip: true, reason: "OTP/2FA code", permanent: false };
  if (HARD_SPAM.some((p) => p.test(allText)))
    return { skip: true, reason: "spam", permanent: true };
  if (LINKEDIN_COLD.some((p) => p.test(allText)))
    return { skip: true, reason: "LinkedIn cold outreach", permanent: true };

  return null;
}

// ─── AI init ───────────────────────────────────────────────────────────────────

async function getAnthropic(): Promise<any | null> {
  if (_anthropicDead) return null;
  if (_anthropic) return _anthropic;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  _anthropic = new (Anthropic as any)({ apiKey: key });
  return _anthropic;
}

async function getGroq(): Promise<any | null> {
  if (_groqDead || _groq) return _groq ?? null;
  const key = process.env.GROQ_API_KEY;
  if (!key) return null;
  // Groq uses OpenAI-compatible API
  _groq = {
    apiKey: key,
    baseUrl: "https://api.groq.com/openai/v1",
  };
  return _groq;
}

async function initAI(): Promise<{ anthropic: any | null; groq: any | null }> {
  const anthropic = await getAnthropic();
  if (anthropic) {
    _provider = "anthropic";
    console.log("[AI] Anthropic -- active");
    return { anthropic, groq: await getGroq() };
  }
  const groq = await getGroq();
  if (groq) {
    _provider = "groq";
    console.log("[AI] Groq -- active");
    return { anthropic: null, groq };
  }
  await pickOllamaModel();
  return { anthropic: null, groq: null };
}

async function pickOllamaModel(): Promise<void> {
  const r = await fetch(`${OLLAMA_URL}/api/tags`, {
    signal: AbortSignal.timeout(3_000),
  }).catch(() => null);
  if (!r?.ok) throw new Error("Ollama not running. Start with: ollama serve");
  const data = (await r.json()) as any;
  const available = (data.models || []).map((m: any) => m.name as string);
  const preferred = [
    "llama3.1:8b",
    "llama3.2:3b",
    "llama3.2:latest",
    "mistral:7b",
    "mistral:latest",
  ];
  const best = preferred.find((m) => available.includes(m)) ?? available[0];
  if (!best) throw new Error("No Ollama models. Run: ollama pull llama3.1:8b");
  OLLAMA_MODEL = best;
  _provider = "ollama";
  console.log(`[AI] Ollama ${OLLAMA_MODEL} — active`);
}

function isCreditError(err: any): boolean {
  const msg = (err?.message || "").toLowerCase();
  const s = err?.status ?? err?.statusCode;
  return (
    msg.includes("credit") ||
    msg.includes("billing") ||
    msg.includes("balance") ||
    s === 402 ||
    (s === 400 && msg.includes("balance"))
  );
}

// ─── LLM calls ─────────────────────────────────────────────────────────────────

async function _callAnthropic(
  a: any,
  model: string,
  prompt: string,
  max: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), API_TIMEOUT_MS);
    a.messages
      .create({
        model,
        max_tokens: max,
        messages: [{ role: "user", content: prompt }],
      })
      .then((r: any) => {
        clearTimeout(t);
        resolve((r.content[0]?.text || "").trim());
      })
      .catch((e: any) => {
        clearTimeout(t);
        reject(e);
      });
  });
}

async function _callGroq(
  model: string,
  prompt: string,
  max: number,
): Promise<string> {
  if (!_groq) throw new Error("Groq not initialized");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
  try {
    const r = await fetch(`${_groq.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${_groq.apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: max,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
      }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`Groq ${r.status}`);
    const data = (await r.json()) as any;
    return (data.choices?.[0]?.message?.content || "").trim();
  } finally {
    clearTimeout(t);
  }
}

async function callOllama(prompt: string, max: number): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), OLLAMA_TIMEOUT_MS);
  try {
    const r = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        stream: false,
        options: { num_predict: max, temperature: 0.1 },
      }),
    });
    if (!r.ok) throw new Error(`Ollama ${r.status}`);
    return (((await r.json()) as any).response || "").trim();
  } finally {
    clearTimeout(t);
  }
}

async function callLLM(
  a: any | null,
  model: string,
  prompt: string,
  max: number,
): Promise<string> {
  if (a && !_anthropicDead) {
    try {
      return await _callAnthropic(a, model, prompt, max);
    } catch (err: any) {
      if (isCreditError(err)) {
        console.log("[AI] Credits depleted -- falling back to Groq/Ollama");
        _anthropicDead = true;
        _provider = _groq && !_groqDead ? "groq" : "ollama";
        if (_provider === "ollama") await pickOllamaModel().catch(() => {});
      } else if ((err?.status ?? err?.statusCode) === 429) {
        await new Promise((r) => setTimeout(r, 3_000));
        try {
          return await _callAnthropic(a, model, prompt, max);
        } catch (retryErr: any) {
          if (isCreditError(retryErr)) {
            console.log(
              "[AI] Credits depleted on retry -- falling back to Groq/Ollama",
            );
            _anthropicDead = true;
            _provider = _groq && !_groqDead ? "groq" : "ollama";
            if (_provider === "ollama") await pickOllamaModel().catch(() => {});
          }
        }
      } else {
        throw err;
      }
    }
  }
  if (_groq && !_groqDead && _provider !== "ollama") {
    try {
      return await _callGroq(GROQ_MODEL, prompt, max);
    } catch (err: any) {
      console.log(
        `[AI] Groq failed (${err.message}) -- falling back to Ollama`,
      );
      _groqDead = true;
      _provider = "ollama";
      await pickOllamaModel().catch(() => {});
    }
  }
  return callOllama(prompt, max);
}

function parseJSON<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text);
  } catch {}
  const oi = text.indexOf("{"),
    ai = text.indexOf("[");
  const ci = text.lastIndexOf("}"),
    di = text.lastIndexOf("]");
  // Pick whichever bracket pair appears first and closes
  let candidate = "";
  if (oi !== -1 && ci !== -1 && (ai === -1 || oi < ai))
    candidate = text.slice(oi, ci + 1);
  else if (ai !== -1 && di !== -1) candidate = text.slice(ai, di + 1);
  if (candidate) {
    try {
      return JSON.parse(candidate);
    } catch {}
    try {
      return JSON.parse(candidate.replace(/,\s*([\]}])/g, "$1"));
    } catch {}
  }
  return fallback;
}

function jPrompt(prompt: string, shape: "object" | "array" = "object"): string {
  const [ex, s, e] = shape === "array" ? ["[ ]", "[", "]"] : ["{ }", "{", "}"];
  return `${prompt}\n\nReturn valid JSON ${ex} ONLY. No markdown, no explanation. Start with ${s} end with ${e}.`;
}

// ─── iMessage output formatter ─────────────────────────────────────────────────

function toBoldUnicode(str: string): string {
  return [...str]
    .map((c) => {
      const code = c.codePointAt(0) ?? 0;
      if (code >= 65 && code <= 90)
        return String.fromCodePoint(0x1d5d4 + code - 65);
      if (code >= 97 && code <= 122)
        return String.fromCodePoint(0x1d5ee + code - 97);
      if (code >= 48 && code <= 57)
        return String.fromCodePoint(0x1d7ec + code - 48);
      return c;
    })
    .join("");
}

/** Convert markdown to iMessage-native formatting.
 *  Unicode Mathematical Bold block renders as real bold on iPhone.
 */
function renderForIMessage(text: string): string {
  return text
    .replace(/\u2014/g, ",")
    .replace(/ -- /g, ", ")
    .replace(/^#{1,3}\s+(.+)$/gm, (_, h) => toBoldUnicode(h.toUpperCase()))
    .replace(/\*\*([^*\n]+)\*\*/g, (_, inner) => toBoldUnicode(inner))
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/_([^_\n]+)_/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^[ \t]*[-*]\s+/gm, "* ")
    .replace(/^[-*]{3,}\s*$/gm, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** DuckDuckGo instant-answer fallback for when Perplexity is not configured. */
async function duckDuckGoSearch(query: string): Promise<string | null> {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const r = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!r.ok) return null;
    const data = (await r.json()) as any;
    const parts: string[] = [];
    if (data.AbstractText) parts.push(data.AbstractText);
    if (data.Answer) parts.push(data.Answer);
    if (data.RelatedTopics?.length) {
      parts.push(
        ...(data.RelatedTopics as any[])
          .slice(0, 3)
          .map((t: any) => t.Text)
          .filter(Boolean),
      );
    }
    return parts.length ? parts.join("\n") : null;
  } catch {
    return null;
  }
}

// ─── Caleb's identity ──────────────────────────────────────────────────────────

function buildCalebSystem(mem: AgentMemory): string {
  // Keep first 2 (baseline identity) + last 3 (most recent learnings) — avoids 6000+ char bloat
  const all = [
    ...new Set([
      ...mem.agentLearnings.slice(0, 2),
      ...mem.agentLearnings.slice(-3),
    ]),
  ];
  const facts = all.length
    ? all.map((l) => `- ${l}`).join("\n")
    : "- 20yo, USC, entrepreneur\n- texts like a college student: short, lowercase, no punctuation";
  const style = mem.styleSnapshot
    ? `avg ${mem.styleSnapshot.patterns.avgMessageLength} chars, ${mem.styleSnapshot.patterns.toneDescriptor}, phrases: ${mem.styleSnapshot.patterns.characteristicPhrases.slice(0, 4).join(", ")}`
    : "short, lowercase, 1-2 sentences. yo, bro, fr, bet, lmk, been heads down";
  return `You ARE Caleb Newton texting from iPhone. First person, never reveal AI.

FACTS:
${facts}

STYLE: ${style}

RULES: Reply text ONLY. No labels, no quotes. Never START a sentence with "certainly", "absolutely", "of course", "great,". Never say "happy to help", "feel free to", "please let me know", "I'd be happy to", "how can I assist" — these are AI tells.`;
}

// ─── Safety filter ─────────────────────────────────────────────────────────────

// Exact string phrases that expose AI identity (substring match on lowercased reply)
const LEAK_STRINGS = [
  "caleb's agent",
  "caleb's assistant",
  "caleb's automated",
  "caleb newton's agent",
  "i'm an ai",
  "i am an ai",
  "this is an automated",
  "speaking on behalf",
  "i'm not available",
  "i will respond shortly",
  "i'll get back to you",
  "i will get back to you",
  "i acknowledge",
  "i've scanned",
  "i have scanned",
  "how can i assist",
  "happy to help",
  "i'd be happy to",
  "i'm not familiar with you",
  "i'm not sure who you are",
  "can you please introduce yourself",
  "feel free to",
  "please let me know",
  "i hope this helps",
  "i appreciate your",
  "as an assistant",
  "i understand your",
  "it's worth noting",
  "i should mention",
  "i want to clarify",
];
// Regex patterns for context-sensitive AI tells
// "certainly/absolutely/of course" are only AI tells as sentence openers — not mid-sentence
const LEAK_REGEX = [
  /scanning\b.{0,20}\binbox/i,
  /\bas an ai\b/i,
  /^(certainly|absolutely)[,!. ]/i,
  /^of course[,!.]/i,
  /^great(,|!| question)/i,
];

/**
 * @param fromCaleb - true when Caleb typed this himself; skips AI-detection checks
 *   (length cap + LEAK_STRINGS still irrelevant for human-typed text).
 *   Only apply the minimum-length guard to reject empty strings.
 */
function isSafe(reply: string, fromCaleb = false): boolean {
  if (!reply || reply.trim().length < 2) return false;
  if (fromCaleb) return true; // Human-typed — trust it completely
  if (reply.length > MAX_REPLY_LEN) return false;
  const lower = reply.toLowerCase();
  return (
    !LEAK_STRINGS.some((p) => lower.includes(p)) &&
    !LEAK_REGEX.some((r) => r.test(lower))
  );
}

// Skip reasons that carry no useful learning signal — filtered before extractLearnings
const TRIVIAL_SKIP_REASONS = new Set([
  "reactions only",
  "group chat",
  "always skip",
  "pending answer",
  "replied recently",
  "media only",
  "empty",
]);

// ─── Triage ────────────────────────────────────────────────────────────────────

interface TriageResult {
  action: "auto_reply" | "ask_caleb" | "skip";
  reason: string;
  questionForCaleb?: string;
  priority: 1 | 2 | 3;
  needsResearch: boolean;
}

async function triage(
  a: any | null,
  handle: string,
  msgs: Message[],
  contact: ContactProfile,
  isOllama: boolean,
): Promise<TriageResult> {
  const sorted = [...msgs].sort((x, y) => x.date.getTime() - y.date.getTime());

  // Already replied? Use findLast to avoid creating throwaway reversed copies
  const lastThem = sorted.findLast((m) => !m.isFromMe);
  const lastMe = sorted.findLast((m) => m.isFromMe);
  if (lastMe && lastThem && lastMe.date.getTime() > lastThem.date.getTime()) {
    return {
      action: "skip",
      reason: "already replied",
      priority: 3,
      needsResearch: false,
    };
  }

  const name = getName(handle, contact);
  // Use THEM as speaker label — avoids sending contact names to Anthropic servers unnecessarily
  const hh = (d: Date) =>
    `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
  const thread = sorted
    .slice(-8)
    .map(
      (m) =>
        `[${m.isFromMe ? "CALEB" : "THEM"} ${hh(m.date)}]: ${(m.text || "[media]").slice(0, 200)}`,
    )
    .join("\n");

  const ctx = [
    contact.vibe && `who: ${contact.vibe}`,
    contact.relationship && `rel: ${contact.relationship}`,
    contact.autoReplyOk && `auto-reply approved`,
    contact.trustScore > 0.5 && `trusted`,
  ]
    .filter(Boolean)
    .join(", ");

  // Shorter prompt for Ollama — it follows simple instructions better
  const prompt = isOllama
    ? jPrompt(`Triage iMessage for Caleb Newton (20, USC, entrepreneur).
FROM: ${name}
CONTEXT: ${ctx || "unknown"}
MESSAGES:
${thread}

skip=no reply needed, auto_reply=simple friendly response, ask_caleb=needs Caleb's decision
If ask_caleb, include questionForCaleb field with the question to ask.
{"action":"skip","reason":"brief","questionForCaleb":"omit if not ask_caleb","priority":2,"needsResearch":false}`)
    : jPrompt(`Triage iMessage for Caleb Newton.
CONTACT: ${name}
CONTEXT: ${ctx || "unknown"}
THREAD:
${thread}
skip=spam/OTP/already replied/no reply, auto_reply=simple low-stakes, ask_caleb=scheduling/money/decisions/unknowns
priority: 1=urgent today, 2=normal, 3=cold/low
{"action":"auto_reply","reason":"brief","questionForCaleb":"only if ask_caleb, else omit","priority":2,"needsResearch":false}`);

  try {
    const text = await callLLM(a, HAIKU, prompt, isOllama ? 150 : 300);
    const raw = parseJSON<TriageResult>(text, {
      action: "ask_caleb",
      reason: "parse failed",
      priority: 2,
      needsResearch: false,
    });
    // Sanitize — models return out-of-range priority or stringified booleans
    if (![1, 2, 3].includes(raw.priority)) raw.priority = 2;
    raw.needsResearch = Boolean(raw.needsResearch);
    if (!["auto_reply", "ask_caleb", "skip"].includes(raw.action))
      raw.action = "ask_caleb";
    return raw;
  } catch (err: any) {
    return {
      action: "ask_caleb",
      reason: `error: ${err.message}`,
      priority: 2,
      needsResearch: false,
    };
  }
}

// ─── Reply generation ──────────────────────────────────────────────────────────

async function generateReply(
  a: any,
  msgs: Message[],
  contact: ContactProfile,
  researchCtx?: string,
): Promise<string> {
  const sorted = [...msgs].sort((x, y) => x.date.getTime() - y.date.getTime());
  const name = getName(contact.handle, contact);
  const thread = sorted
    .slice(-10)
    .map(
      (m) =>
        `[${m.isFromMe ? "CALEB" : "THEM"}]: ${(m.text || "[media]").slice(0, 300)}`,
    )
    .join("\n");

  const prompt = `${buildCalebSystem(memory)}

TEXTING: ${name}${contact.vibe ? ` — ${contact.vibe}` : ""}
${contact.howCalebtexts ? `HOW CALEB TEXTS THEM: ${contact.howCalebtexts}` : ""}
${researchCtx ? `\nCONTEXT:\n${researchCtx}` : ""}

THREAD:
${thread}

Caleb's reply:`;

  return callLLM(a, SONNET, prompt, 200);
}

// ─── Semaphore ─────────────────────────────────────────────────────────────────

class Semaphore {
  private q: Array<() => void> = [];
  private n = 0;
  constructor(private limit: number) {}
  async acquire() {
    if (this.n < this.limit) {
      this.n++;
      return;
    }
    return new Promise<void>((r) =>
      this.q.push(() => {
        this.n++;
        r();
      }),
    );
  }
  release() {
    this.n--;
    this.q.shift()?.();
  }
}

// ─── Contact update (Anthropic only) ──────────────────────────────────────────

function updateContactAsync(
  a: any,
  handle: string,
  msgs: Message[],
  sent: string,
): void {
  if (!a || _anthropicDead) return;
  const contact = getOrCreateContact(memory, handle);
  const sorted = [...msgs].sort((x, y) => x.date.getTime() - y.date.getTime());
  const thread = sorted
    .slice(-5)
    .map(
      (m) =>
        `[${m.isFromMe ? "CALEB" : "THEM"}]: ${(m.text || "[media]").slice(0, 150)}`,
    )
    .join("\n");
  callLLM(
    a,
    HAIKU,
    jPrompt(`Update this iMessage contact profile.
THREAD:\n${thread}\nCALEB REPLIED: "${sent}"
EXISTING: ${JSON.stringify({ vibe: contact.vibe, relationship: contact.relationship })}
{"displayName":"or null","relationship":"friend|bma|family|school|investor|creator|colleague|professor|random","vibe":"1 sentence","howCalebtexts":"1 sentence","recentTopics":["t"],"autoReplyOk":false}`),
    250,
  )
    .then((text) => {
      const u = parseJSON<any>(text, {});
      if (!u || !Object.keys(u).length) return;
      Object.assign(contact, {
        // Never overwrite a real name with null — model sometimes returns null for unknown contacts
        ...(u.displayName ? { displayName: u.displayName } : {}),
        relationship: u.relationship || contact.relationship,
        vibe: u.vibe || contact.vibe,
        howCalebtexts: u.howCalebtexts || contact.howCalebtexts,
        // Cap recent topics — unbounded growth bloats memory.json
        recentTopics: [
          ...new Set([
            ...(u.recentTopics || []),
            ...(contact.recentTopics || []),
          ]),
        ].slice(0, 8),
        autoReplyOk: contact.autoReplyOk ? true : (u.autoReplyOk ?? false),
        handle,
        sentCount: contact.sentCount,
        trustScore: contact.trustScore,
        perplexityCache: contact.perplexityCache,
        notes: contact.notes,
      });
      memory.contacts[handle] = contact;
    })
    .catch(() => {});
}

// ─── Style analyzer ────────────────────────────────────────────────────────────

async function analyzeStyle(a: any): Promise<void> {
  if (!a || _anthropicDead) {
    console.log(
      "[style] No Anthropic credits — using Ollama (lower quality). Top up at console.anthropic.com/billing for best results.",
    );
  }
  console.log("Analyzing Caleb's texting style...");
  const result = await sdk.getMessages({
    excludeOwnMessages: false,
    limit: 1000,
  });
  const sent = result.messages
    // Exclude group chats — Caleb's style differs in 1:1 vs group contexts
    .filter(
      (m) =>
        m.isFromMe &&
        !m.isGroupChat &&
        m.text &&
        m.text.length >= 4 &&
        m.text.length <= 300,
    )
    .map((m) => m.text!);
  if (sent.length < 20) {
    console.log("Need 20+ sent messages. Check Full Disk Access.");
    return;
  }

  const half = Math.floor(sent.length / 2);
  const sample = [
    ...sent
      .slice(0, half)
      .filter((_, i) => i % Math.max(1, Math.floor(half / 50)) === 0)
      .slice(0, 50),
    ...sent
      .slice(half)
      .filter(
        (_, i) => i % Math.max(1, Math.floor((sent.length - half) / 25)) === 0,
      )
      .slice(0, 25),
  ];

  const results: any[] = [];
  for (const chunk of [sample.slice(0, 40), sample.slice(40)].filter(
    (c) => c.length,
  )) {
    const text = await callLLM(
      a,
      HAIKU,
      jPrompt(`Analyze real iMessages by Caleb Newton.
Return: {"avgLen":50,"medianLen":40,"lowercase":true,"openers":["yo"],"closers":["lmk"],"emoji":"rare","punctuation":"minimal","phrases":["been heads down"],"tone":"casual direct brief"}
MESSAGES:\n${chunk.map((m, i) => `${i + 1}. "${m}"`).join("\n")}`),
      500,
    );
    const p = parseJSON<any>(text, null);
    if (p) results.push(p);
  }

  if (!results.length) {
    console.log("No data returned");
    return;
  }
  const p =
    results.length > 1
      ? {
          avgLen: Math.round(
            ((+results[0].avgLen || 40) + (+results[1].avgLen || 40)) / 2,
          ),
          medianLen: Math.round(
            ((+results[0].medianLen || 35) + (+results[1].medianLen || 35)) / 2,
          ),
          lowercase: results[0].lowercase ?? true,
          openers: [
            ...new Set([
              ...(results[0].openers || []),
              ...(results[1].openers || []),
            ]),
          ].slice(0, 8),
          closers: [
            ...new Set([
              ...(results[0].closers || []),
              ...(results[1].closers || []),
            ]),
          ].slice(0, 8),
          emoji: results[0].emoji || "rare",
          punctuation: results[0].punctuation || "minimal",
          phrases: [
            ...new Set([
              ...(results[0].phrases || []),
              ...(results[1].phrases || []),
            ]),
          ].slice(0, 12),
          tone: results[0].tone || "casual, direct, brief",
        }
      : results[0];

  memory.styleSnapshot = {
    capturedAt: new Date().toISOString(),
    sampleSize: sample.length,
    patterns: {
      avgMessageLength: +p.avgLen || 50,
      medianMessageLength: +p.medianLen || 40,
      usesLowercase: p.lowercase ?? true,
      commonOpeners: p.openers || [],
      commonClosers: p.closers || [],
      emojiUsage: p.emoji || "rare",
      punctuationStyle: p.punctuation || "minimal",
      characteristicPhrases: p.phrases || [],
      toneDescriptor: p.tone || "casual, direct, brief",
    },
  };
  saveMemory(memory);
  console.log(
    `Style: ${p.avgLen} avg chars, "${p.tone}", phrases: ${(p.phrases || []).slice(0, 5).join(", ")}`,
  );
}

// ─── Learning extraction ───────────────────────────────────────────────────────

async function extractLearnings(
  a: any,
  processed: Array<{
    handle: string;
    action: string;
    reason: string;
    contact: ContactProfile;
  }>,
): Promise<void> {
  if (!processed.length) return;
  // Ollama can do learning extraction too — just uses a simpler model
  const summary = processed
    .slice(0, 20)
    .map(
      (p) =>
        `${getName(p.handle, p.contact)}(${p.contact.relationship || "?"}): ${p.action} — ${p.reason}`,
    )
    .join("\n");
  try {
    const text = await callLLM(
      a,
      HAIKU,
      jPrompt(
        `Extract 1-2 NEW learnings about Caleb Newton from triage. Return [] if nothing genuinely new.
EXISTING:\n${memory.agentLearnings.slice(-4).join("\n")}\nRESULTS:\n${summary}`,
        "array",
      ),
      200,
    );
    const ls = parseJSON<string[]>(text, []);
    if (Array.isArray(ls)) ls.forEach((l) => addLearning(memory, l));
  } catch {}
}

// ─── Main run ──────────────────────────────────────────────────────────────────

async function runAgent(): Promise<void> {
  const { anthropic } = await initAI();
  // Capture isOllama BEFORE parallel jobs — _provider could change mid-run on credit error
  // Passed directly into triage() so each job sees the correct pre-run value
  const isOllama = _provider === "ollama" || _anthropicDead;
  const sem = new Semaphore(isOllama ? 2 : 8);

  const runTag = DRY_RUN
    ? "⚠ DRY RUN — no messages will be sent"
    : `LIVE [${_provider}]`;
  console.log(`\n=== Caleb's iMessage Agent [${runTag}] ===`);
  console.log(`Contacts loaded: ${contactCount()}\n`);
  memory.stats.totalRuns++;

  // Show pending questions (cap at 5 so output stays readable)
  const pending = getUnansweredQuestions(memory);
  if (pending.length) {
    console.log(`=== ${pending.length} PENDING ===`);
    for (const q of pending.slice(0, 5)) {
      const name = getName(q.handle, memory.contacts[q.handle]);
      console.log(`\n[${name}] "${q.messagePreview.slice(0, 80)}"`);
      q.questions.forEach((question) => console.log(`  ? ${question}`));
      if (q.draftReply) console.log(`  Draft: "${q.draftReply.slice(0, 60)}"`);
      console.log(
        `  → bun run agent.ts --mode answer --id ${q.id} --answer "yes"`,
      );
    }
    if (pending.length > 5)
      console.log(
        `  … and ${pending.length - 5} more (run --mode scan to see all)`,
      );
    console.log();
  }

  const unread = await sdk.getUnreadMessages();
  console.log(`Unread: ${unread.total} from ${unread.senderCount} senders`);
  if (!unread.total) {
    console.log("Inbox clean.");
    return;
  }

  const groups = [...unread.groups]
    .filter((g) => g.sender && !CALEB_HANDLES.has(normalizeHandle(g.sender))) // drop empty/own senders
    .sort((a, b) => {
      // Trusted contacts first, then by unread count
      const ca = memory.contacts[normalizeHandle(a.sender)];
      const cb = memory.contacts[normalizeHandle(b.sender)];
      return (
        (cb?.trustScore ?? 0) - (ca?.trustScore ?? 0) ||
        b.messages.length - a.messages.length
      );
    })
    .slice(0, LIMIT); // limit AFTER sort so high-trust contacts are never dropped

  let sent = 0,
    questions = 0,
    filtered = 0;
  const learned: Array<{
    handle: string;
    action: string;
    reason: string;
    contact: ContactProfile;
  }> = [];

  const jobs = groups.map((group) => async () => {
    await sem.acquire();
    try {
      const handle = normalizeHandle(group.sender);
      const msgs = group.messages as Message[];
      const contact = getOrCreateContact(memory, handle); // always returns a value

      // Sync name from AddressBook
      syncName(handle, contact);

      // Update last contacted
      const latest = [...msgs].sort(
        (a, b) => b.date.getTime() - a.date.getTime(),
      )[0];
      if (latest) contact.lastContactedAt = latest.date.toISOString();

      // Known permanent skip
      if (contact.alwaysSkip) {
        return { handle, action: "skip", reason: "always skip", contact, msgs };
      }

      // Already have an unanswered question for this contact — don't re-queue
      const hasPending = memory.pendingQuestions.some(
        (q) => q.handle === handle && !q.answered,
      );
      if (hasPending) {
        return {
          handle,
          action: "skip",
          reason: "pending answer",
          contact,
          msgs,
        };
      }

      // Recently replied (within 2h) AND they haven't responded since — avoid re-queuing
      const recentSend = memory.sentLog.findLast((s) => s.to === handle);
      if (
        recentSend &&
        Date.now() - new Date(recentSend.sentAt).getTime() < 2 * 3600 * 1000
      ) {
        // If they've replied since our last send, don't suppress — they're waiting for us
        const ourSentAt = new Date(recentSend.sentAt).getTime();
        const theyRepliedSince = msgs.some(
          (m) => !m.isFromMe && m.date.getTime() > ourSentAt,
        );
        if (!theyRepliedSince) {
          return {
            handle,
            action: "skip",
            reason: "replied recently",
            contact,
            msgs,
          };
        }
      }

      // Crisis detection: flag emergency signals, skip auto-reply, escalate immediately
      const CRISIS_RE =
        /\b(kill(ing)? (my|him|her|them)?self|suicid(al|e)|want to die|end (my|this) life|hurt(ing)? (my|him|her|them)?self|in danger|emergency|help me|call 911|abuse|he hit|she hit|being (hurt|abused))\b/i;
      const lastInboundText = msgs.findLast((m) => !m.isFromMe)?.text ?? "";
      if (CRISIS_RE.test(lastInboundText)) {
        const preview = lastInboundText.slice(0, 200);
        addPendingQuestion(
          memory,
          handle,
          preview,
          `CRISIS SIGNAL: "${preview.slice(0, 80)}" -- reply immediately, do not auto-reply`,
        );
        if (process.env.SLACK_WEBHOOK_URL) {
          postSlack(
            process.env.SLACK_WEBHOOK_URL,
            `URGENT: ${getName(handle, contact)} (${handle}) may need help. Message: "${preview}"`,
          ).catch(() => {});
        }
        return {
          handle,
          action: "ask_caleb",
          reason: "crisis signal",
          contact,
          msgs,
        };
      }

      // Pre-filter (no LLM)
      const pf = preFilter(msgs);
      if (pf) {
        if (pf.permanent) markAlwaysSkip(memory, handle, pf.reason);
        return { handle, action: "skip", reason: pf.reason, contact, msgs };
      }

      // Skip media-only threads — no text means nothing to intelligently reply to
      const hasText = msgs.some((m) => m.text && m.text.trim().length > 0);
      if (!hasText)
        return { handle, action: "skip", reason: "media only", contact, msgs };

      // Pull fuller thread using correct SDK filter field (sender, not handle)
      let thread: Message[] = msgs;
      try {
        const full = await sdk.getMessages({
          sender: handle,
          limit: 12,
          excludeReactions: true,
        });
        if (full?.messages?.length) thread = full.messages as Message[];
      } catch {}

      const result = await triage(anthropic, handle, thread, contact, isOllama);
      return {
        handle,
        action: result.action,
        triage: result,
        contact,
        msgs,
        thread,
      };
    } catch (err: any) {
      if (DEBUG) console.error(`[job error] ${group.sender}: ${err.message}`);
      return {
        handle: normalizeHandle(group.sender),
        action: "skip",
        reason: `error: ${err.message}`,
        contact: getOrCreateContact(memory, normalizeHandle(group.sender)),
        msgs: group.messages as Message[],
      };
    } finally {
      sem.release();
    }
  });

  const results = await Promise.all(jobs.map((j) => j()));

  // Priority 1 → 2 → 3
  results.sort(
    (a, b) =>
      ((a as any).triage?.priority ?? 3) - ((b as any).triage?.priority ?? 3),
  );

  for (const r of results) {
    const { handle, action, contact } = r;
    const t = (r as any).triage;
    const msgs = (r as any).msgs as Message[];
    const thread = ((r as any).thread as Message[]) || msgs;
    const name = getName(handle, contact);

    if (action === "skip") {
      filtered++;
      if (DEBUG) console.log(`  ⚪ [${name}]: ${(r as any).reason}`);
      if (!TRIVIAL_SKIP_REASONS.has((r as any).reason)) {
        learned.push({
          handle,
          action: "skip",
          reason: (r as any).reason,
          contact,
        });
      }
      continue;
    }

    // BMA prospect reply: classify intent and route to deal team Slack (fire-and-forget)
    if (isBmaProspect(contact) && process.env.BMA_SLACK_WEBHOOK) {
      const lastInbound = thread.findLast((m) => !m.isFromMe);
      if (lastInbound?.text) {
        // Log inbound interaction to Firestore too
        logInteraction(
          handle,
          getName(handle, contact),
          lastInbound.text,
          "inbound",
          "prospect reply",
        ).catch(() => {});
        routeProspectReply(contact, lastInbound.text, anthropic).catch(
          () => {},
        );
      }
    }

    if (action === "ask_caleb") {
      const lastMsg = thread.findLast((m) => !m.isFromMe);
      const preview = lastMsg?.text || "[media]";

      // Only generate draft if Anthropic is available
      let draft: string | undefined;
      if (anthropic && !_anthropicDead) {
        try {
          const candidate = await generateReply(anthropic, thread, contact);
          if (isSafe(candidate)) draft = candidate;
        } catch {}
      }

      addPendingQuestion(
        memory,
        handle,
        preview,
        t?.questionForCaleb || "How should Caleb respond?",
        draft,
      );
      questions++;
      const p = t?.priority === 1 ? "🔴" : t?.priority === 2 ? "🟡" : "⚪";
      console.log(
        `${p} [${name}]${draft ? ` (draft ready)` : ""} → ${t?.questionForCaleb || "Needs your call"}`,
      );
      learned.push({
        handle,
        action: "ask_caleb",
        reason: t?.reason || "escalated",
        contact,
      });
      continue;
    }

    // auto_reply
    if (isOllama && !contact.autoReplyOk && contact.trustScore < 0.3) {
      const lastMsg = thread.findLast((m) => !m.isFromMe);
      addPendingQuestion(
        memory,
        handle,
        lastMsg?.text || "[media]",
        `Should Caleb reply to ${name}?`,
      );
      questions++;
      console.log(`⚪ [${name}] → queued (Ollama: no draft generated)`);
      learned.push({
        handle,
        action: "ask_caleb",
        reason: "Ollama unverified",
        contact,
      });
      continue;
    }

    if (sent >= MAX_AUTO_SENDS) {
      if (DEBUG) console.log(`[cap] ${MAX_AUTO_SENDS} sends`);
      break;
    }

    // Guard: credits may have depleted during parallel triage — re-check before generating
    if (_anthropicDead || !anthropic) {
      const lastMsg = thread.findLast((m) => !m.isFromMe);
      addPendingQuestion(
        memory,
        handle,
        lastMsg?.text || "[media]",
        `Should Caleb reply to ${name}?`,
      );
      questions++;
      console.log(`⚪ [${name}] → queued (credits depleted mid-run)`);
      learned.push({
        handle,
        action: "ask_caleb",
        reason: "credits depleted mid-run",
        contact,
      });
      continue;
    }

    // Research
    let researchCtx: string | undefined;
    if (t?.needsResearch) {
      const lastMsg = thread.findLast((m) => !m.isFromMe);
      const lastText = lastMsg?.text || "";
      // Use full text as cache key -- truncating to 100 chars caused false cache hits
      // when different messages shared the same opening substring
      const cacheKey = `${handle}::${lastText}`;
      const cached = getCachedResearch(memory, handle, cacheKey);
      if (cached) {
        researchCtx = cached;
      } else if (process.env.PERPLEXITY_API_KEY) {
        const query = await buildResearchQuery(
          lastText,
          contact.displayName,
          contact.vibe,
          anthropic,
          HAIKU,
          OLLAMA_MODEL,
          OLLAMA_URL,
        );
        if (query) {
          const res = await research(
            query,
            buildPerplexitySystem(
              memory.styleSnapshot?.patterns.toneDescriptor ??
                "casual, direct, brief",
              memory.agentLearnings,
            ),
            process.env.PERPLEXITY_API_KEY,
          );
          if (res?.content) {
            researchCtx = res.content;
            setCachedResearch(memory, handle, cacheKey, res.content);
          }
        }
      } else {
        // Fallback: DuckDuckGo instant answers
        const result = await duckDuckGoSearch(lastText.slice(0, 100));
        if (result) researchCtx = result;
      }
    }

    // Check if contact is in GPT-chat mode before standard reply
    let finalReply: string | null = null;
    let isGptChat = false;

    if (db && process.env.ANTHROPIC_API_KEY) {
      try {
        const dbContact = await db.getOrCreateContact(handle);
        if (dbContact.conversation_mode === "gpt_chat") {
          isGptChat = true;
          const session = await getOrBootstrapSession(
            dbContact,
            process.env.AGENT_USER_ID!,
            db,
          );
          const lastInbound = thread.findLast((m) => !m.isFromMe);
          const incomingText = lastInbound?.text ?? "";
          if (incomingText) {
            const ctx: ConvoContext = {
              user: {
                display_name: "Caleb",
                persona:
                  "Caleb Newton, USC sophomore, serial entrepreneur, 20yo. Short texts, lowercase, no fluff.",
                own_handles: [...CALEB_HANDLES],
              },
              contact: dbContact,
              session,
            };
            const convoResult = await generateConvoReply(
              incomingText,
              ctx,
              db,
              process.env.ANTHROPIC_API_KEY,
            );
            const quality = checkReplyQuality(convoResult.text);
            if (quality.ok && isSafe(convoResult.text)) {
              finalReply = convoResult.text;
              await db
                .recordSent({
                  toHandle: handle,
                  message: finalReply,
                  conversationMode: true,
                  sessionId: session.id,
                })
                .catch(() => {});
            }
          }
        }
      } catch (err: any) {
        // DB error — fall through to standard path
        if (DEBUG) console.error(`[run] DB error: ${err.message}`);
      }
    }

    if (!isGptChat) {
      const candidate = await generateReply(
        anthropic!,
        thread,
        contact,
        researchCtx,
      );
      if (candidate && isSafe(candidate)) finalReply = candidate;
    }

    if (!finalReply) {
      const lastMsg = thread.findLast((m) => !m.isFromMe);
      addPendingQuestion(
        memory,
        handle,
        lastMsg?.text || "[media]",
        `Draft failed safety check — how should Caleb reply?`,
      );
      questions++;
      console.log(`   ⚠ [${name}] unsafe draft — escalated`);
      learned.push({
        handle,
        action: "ask_caleb",
        reason: "safety filter",
        contact,
      });
      continue;
    }

    const p = t?.priority === 1 ? "🔴" : t?.priority === 2 ? "🟡" : "⚪";
    console.log(
      `\n${p} [${name}]${isGptChat ? " [gpt_chat]" : ""} → "${finalReply}"`,
    );
    console.log(`   ${t?.reason}`);

    if (!DRY_RUN) {
      try {
        const formatted = renderForIMessage(finalReply);
        await sdk.send(handle, formatted);
        recordSent(
          memory,
          handle,
          formatted,
          t?.reason || (isGptChat ? "gpt_chat" : "auto_reply"),
          false,
        );
        if (!isGptChat)
          updateContactAsync(anthropic!, handle, thread, formatted);
        // Log outbound interaction to Firestore (fire-and-forget)
        logInteraction(
          handle,
          getName(handle, contact),
          formatted,
          "outbound",
          t?.reason || "auto_reply",
        ).catch(() => {});
        sent++;
        console.log("   sent");
        // Throttle sends -- rapid-fire iMessages to many contacts can get flagged by Apple
        if (sent < MAX_AUTO_SENDS) await new Promise((r) => setTimeout(r, 400));
      } catch (err: any) {
        console.error(`   send failed: ${err.message}`);
      }
    } else {
      const formatted = renderForIMessage(finalReply);
      recordSent(
        memory,
        handle,
        formatted,
        t?.reason || (isGptChat ? "gpt_chat" : "auto_reply"),
        true,
      );
      sent++;
      console.log("   (dry run)");
    }
    learned.push({
      handle,
      action: "auto_reply",
      reason: t?.reason || "",
      contact,
    });
  }

  // Await learnings so they're captured before saveMemory in finally block
  try {
    await extractLearnings(anthropic, learned);
  } catch {}
  memory.lastRunAt = new Date().toISOString();
  // Cap sentLog to last 500 — unbounded growth bloats memory.json
  if (memory.sentLog.length > 500) memory.sentLog = memory.sentLog.slice(-500);
  // Cap agentLearnings — keep baseline (first 2) + most recent 48 = max 50 entries
  if (memory.agentLearnings.length > 50) {
    memory.agentLearnings = [
      ...memory.agentLearnings.slice(0, 2),
      ...memory.agentLearnings.slice(-48),
    ];
  }
  // memory is saved in the finally block — no need to save twice

  console.log(`\n─── Done ───`);
  console.log(
    `Sent: ${sent} | Questions: ${questions} | Filtered: ${filtered}`,
  );
  console.log(
    `All-time: ${memory.stats.totalSent} real, ${memory.stats.totalDryRun} dry`,
  );
}

// ─── Inbox ─────────────────────────────────────────────────────────────────────

async function showInbox(): Promise<void> {
  const unread = await sdk.getUnreadMessages();
  console.log(
    `\n=== Inbox: ${unread.total} unread, ${unread.senderCount} senders | ${contactCount()} contacts loaded ===\n`,
  );

  const groups = [...unread.groups]
    .filter((g) => g.sender && !CALEB_HANDLES.has(normalizeHandle(g.sender)))
    .sort((a, b) => {
      const ta = memory.contacts[normalizeHandle(a.sender)]?.trustScore ?? 0;
      const tb = memory.contacts[normalizeHandle(b.sender)]?.trustScore ?? 0;
      return tb - ta || b.messages.length - a.messages.length;
    });

  for (const group of groups.slice(0, LIMIT)) {
    const handle = normalizeHandle(group.sender);
    const contact = memory.contacts[handle];
    const msgs = group.messages as Message[];
    const name = getName(handle, contact);
    const pf = preFilter(msgs);
    const tag = pf ? ` [${pf.reason}]` : "";
    const rel = contact?.relationship ? ` [${contact.relationship}]` : "";
    const skip = contact?.alwaysSkip ? " [SKIP]" : "";

    console.log(`${name}${rel}${skip}${tag}`);
    const sorted = [...msgs].sort(
      (a, b) => b.date.getTime() - a.date.getTime(),
    );
    for (const m of sorted.slice(0, 3)) {
      console.log(
        `  ${m.date.toLocaleTimeString()} ${(m.text || "[media]").slice(0, 100)}`,
      );
    }
    if (contact?.vibe) console.log(`  → ${contact.vibe}`);
    console.log();
  }

  const pending = getUnansweredQuestions(memory);
  if (pending.length) {
    console.log(`=== ${pending.length} PENDING ===`);
    for (const q of pending.slice(0, 5)) {
      const name = getName(q.handle, memory.contacts[q.handle]);
      console.log(`[${name}] (${q.id}) ${q.questions[0]}`);
      if (q.draftReply) {
        console.log(
          `  Draft: "${q.draftReply.slice(0, 60)}" → --mode answer --id ${q.id} --answer "yes"`,
        );
      } else {
        console.log(`  → --mode answer --id ${q.id} --answer "your reply"`);
      }
    }
  }
}

// ─── Scan ──────────────────────────────────────────────────────────────────────

async function scanMode(): Promise<void> {
  const unread = await sdk.getUnreadMessages();
  const pending = getUnansweredQuestions(memory);

  const groups = [...unread.groups]
    .filter((g) => g.sender && !CALEB_HANDLES.has(normalizeHandle(g.sender)))
    .sort((a, b) => {
      // Known/trusted contacts first, then by message count — matches runAgent sort order
      const ca = memory.contacts[normalizeHandle(a.sender)];
      const cb = memory.contacts[normalizeHandle(b.sender)];
      return (
        (cb?.trustScore ?? 0) - (ca?.trustScore ?? 0) ||
        b.messages.length - a.messages.length
      );
    });
  // Cache preFilter results — used both for stats and display; no need to run twice
  const pfCache = new Map<string, ReturnType<typeof preFilter>>();
  let willFilter = 0,
    willTriage = 0;
  for (const g of groups) {
    const handle = normalizeHandle(g.sender);
    const msgs = g.messages as Message[];
    if (memory.contacts[handle]?.alwaysSkip) {
      pfCache.set(g.sender, {
        skip: true,
        reason: "always skip",
        permanent: false,
      });
      willFilter++;
      continue;
    }
    // Pending question — runAgent will skip this contact
    if (
      memory.pendingQuestions.some((q) => q.handle === handle && !q.answered)
    ) {
      pfCache.set(g.sender, {
        skip: true,
        reason: "pending answer",
        permanent: false,
      });
      willFilter++;
      continue;
    }
    // Recent send (within 2h) and no reply since — runAgent will skip
    const recentSend = memory.sentLog.findLast((s) => s.to === handle);
    if (
      recentSend &&
      Date.now() - new Date(recentSend.sentAt).getTime() < 2 * 3600 * 1000
    ) {
      const theyRepliedSince = msgs.some(
        (m) =>
          !m.isFromMe &&
          m.date.getTime() > new Date(recentSend.sentAt).getTime(),
      );
      if (!theyRepliedSince) {
        pfCache.set(g.sender, {
          skip: true,
          reason: "replied recently",
          permanent: false,
        });
        willFilter++;
        continue;
      }
    }
    const pf = preFilter(msgs);
    pfCache.set(g.sender, pf);
    if (pf) willFilter++;
    else willTriage++;
  }

  console.log("\n=== iMessage ===");
  console.log(`Unread: ${unread.total} from ${unread.senderCount} senders`);
  console.log(
    `  Will filter (no LLM): ${willFilter} | Will triage: ${willTriage}`,
  );
  console.log(`Pending questions: ${pending.length}`);
  console.log(
    `Contacts: ${contactCount()} in AddressBook, ${Object.keys(memory.contacts).length} profiled`,
  );
  console.log(
    `Sends: ${memory.stats.totalSent} real, ${memory.stats.totalDryRun} dry`,
  );
  console.log(
    `Style: ${memory.styleSnapshot ? `captured ${memory.styleSnapshot.sampleSize} msgs, "${memory.styleSnapshot.patterns.toneDescriptor}"` : "not captured — run --mode style"}`,
  );
  console.log(
    `Last run: ${memory.lastRunAt ? new Date(memory.lastRunAt).toLocaleString() : "never"}`,
  );

  if (groups.length) {
    console.log("\nTop unreads:");
    for (const g of groups.slice(0, 15)) {
      const handle = normalizeHandle(g.sender);
      const contact = memory.contacts[handle];
      const msgs = g.messages as Message[];
      const name = getName(handle, contact);
      const pf = pfCache.get(g.sender);
      const tag = pf ? ` [${pf.reason}]` : "";
      const last = [...msgs].sort(
        (a, b) => b.date.getTime() - a.date.getTime(),
      )[0];
      const preview = last?.text?.slice(0, 70) || "[media]";
      console.log(`  ${name}${tag} (${msgs.length}): "${preview}"`);
    }
  }

  if (pending.length) {
    console.log("\nPending:");
    for (const q of pending.slice(0, 5)) {
      const name = getName(q.handle, memory.contacts[q.handle]);
      console.log(`  [${name}] (${q.id}) ${q.questions[0]}`);
      if (q.draftReply) {
        console.log(`    → --mode answer --id ${q.id} --answer "yes"`);
      } else {
        console.log(`    → --mode answer --id ${q.id} --answer "your reply"`);
      }
    }
  }
}

// ─── Answer mode ───────────────────────────────────────────────────────────────

const APPROVAL = new Set([
  "yes",
  "y",
  "yeah",
  "yep",
  "yup",
  "sure",
  "ok",
  "okay",
  "send",
  "send it",
  "go",
  "go ahead",
  "do it",
  "approved",
  "approve",
]);

async function answerMode(): Promise<void> {
  const id = getFlag("--id");
  const answer = getFlag("--answer");
  if (!id || !answer) {
    console.error('Usage: --mode answer --id q-xxx --answer "yes"');
    process.exit(1);
  }

  const q = memory.pendingQuestions.find((pq) => pq.id === id);
  if (!q) {
    console.error(`Question ${id} not found`);
    process.exit(1);
  }

  const name = getName(q.handle, memory.contacts[q.handle]);
  const lower = answer.toLowerCase().trim();
  // Exact match only — first-word check was too loose ("send me the info" → "send" → false approval)
  const isApproval = APPROVAL.has(lower);

  let didSend = false;

  if (isApproval && q.draftReply && isSafe(q.draftReply)) {
    // Caleb approved the draft
    didSend = await _doSend(
      q.handle,
      q.draftReply,
      `approved draft (${id})`,
      name,
    );
  } else if (isApproval && q.draftReply && !isSafe(q.draftReply)) {
    // Draft was flagged — can't send it, guide Caleb
    console.log(`Draft was flagged as potentially AI-revealing.`);
    console.log(
      `Reply manually: bun run agent.ts --mode send --handle ${q.handle} --message "your reply"`,
    );
    console.log(`Or cancel:      bun run agent.ts --mode cancel --id ${id}`);
  } else if (isApproval && !q.draftReply) {
    // Approved but no draft — need to generate
    const { anthropic } = await initAI().catch(() => ({ anthropic: null }));
    if (!anthropic || _anthropicDead) {
      console.log(`Need Anthropic credits to generate a reply.`);
      console.log(
        `Reply manually: bun run agent.ts --mode send --handle ${q.handle} --message "your reply"`,
      );
      console.log(`Or cancel:      bun run agent.ts --mode cancel --id ${id}`);
    } else {
      const contact = getOrCreateContact(memory, q.handle);
      const msgs = await sdk
        .getMessages({ sender: q.handle, limit: 8 })
        .catch(() => ({ messages: [] }));
      const reply = await generateReply(
        anthropic,
        msgs.messages as Message[],
        contact,
      );
      if (reply && isSafe(reply)) {
        didSend = await _doSend(
          q.handle,
          reply,
          `generated+approved (${id})`,
          name,
        );
      } else {
        console.log("Generated reply failed safety check. Reply manually.");
      }
    }
  } else if (!isApproval && answer.trim().length >= 1) {
    // The answer IS the reply — send it directly
    // fromCaleb=true: Caleb typed this himself; skip AI-detection checks entirely
    didSend = await _doSend(q.handle, answer, `direct answer (${id})`, name);
  } else {
    // Whitespace-only answer — nothing to do
    console.log("Nothing to send.");
  }

  // Mark answered if we sent, OR if Caleb provided a non-empty answer (his decision, even if not sent)
  if (didSend || answer.trim().length >= 1) {
    q.answered = true;
    q.answer = answer;
  }

  saveMemory(memory);
}

async function _doSend(
  handle: string,
  msg: string,
  ctx: string,
  name: string,
): Promise<boolean> {
  if (!DRY_RUN) {
    try {
      const formatted = renderForIMessage(msg);
      await sdk.send(handle, formatted);
      recordSent(memory, handle, formatted, ctx, false);
      console.log(
        `To [${name}]: "${formatted.slice(0, 80)}${formatted.length > 80 ? "..." : ""}"\n checked sent`,
      );
      return true;
    } catch (err: any) {
      console.error(`Failed to send to [${name}]: ${err.message}`);
      return false;
    }
  } else {
    const formatted = renderForIMessage(msg);
    recordSent(memory, handle, formatted, ctx, true);
    console.log(
      `To [${name}]: "${formatted.slice(0, 80)}${formatted.length > 80 ? "..." : ""}"\n(dry run)`,
    );
    return true;
  }
}

// ─── Send mode ─────────────────────────────────────────────────────────────────

async function sendMode(): Promise<void> {
  const handle = getFlag("--handle");
  const message = getFlag("--message");
  if (!handle || !message) {
    console.error('Usage: --mode send --handle +13104296285 --message "yo"');
    process.exit(1);
  }
  const normalized = normalizeHandle(handle);
  const name = getName(normalized, memory.contacts[normalized]);
  await _doSend(normalized, message.trim(), "manual send", name);
  saveMemory(memory);
}

// ─── Clean mode ────────────────────────────────────────────────────────────────

async function cleanMode(): Promise<void> {
  const before = memory.pendingQuestions.length;
  const answered = memory.pendingQuestions.filter((q) => q.answered);
  const unanswered = memory.pendingQuestions.filter((q) => !q.answered);
  let fixed = 0;
  for (const q of unanswered) {
    if (q.draftReply && !isSafe(q.draftReply)) {
      q.draftReply = undefined;
      fixed++;
    }
  }
  const kept = answered.slice(-100);
  memory.pendingQuestions = [...kept, ...unanswered];
  saveMemory(memory);
  const trimmed = answered.length - kept.length;
  console.log(
    `Cleaned: ${before} total → ${memory.pendingQuestions.length} kept`,
  );
  console.log(
    `  ${trimmed} old answered questions pruned, ${fixed} bad drafts removed`,
  );
}

// ─── Skip / Unskip mode ────────────────────────────────────────────────────────

async function skipMode(): Promise<void> {
  const handle = getFlag("--handle");
  if (!handle) {
    console.error("Usage: --mode skip --handle +13104296285");
    process.exit(1);
  }
  const normalized = normalizeHandle(handle);
  const name = getName(normalized, memory.contacts[normalized]);
  markAlwaysSkip(memory, normalized, "manually marked");
  saveMemory(memory);
  console.log(`[${name}] marked as always-skip.`);
}

async function unskipMode(): Promise<void> {
  const handle = getFlag("--handle");
  if (!handle) {
    console.error("Usage: --mode unskip --handle +13104296285");
    process.exit(1);
  }
  const normalized = normalizeHandle(handle);
  const contact = memory.contacts[normalized];
  if (!contact) {
    console.error(`No contact found for ${normalized}`);
    process.exit(1);
  }
  contact.alwaysSkip = false;
  contact.skipReason = undefined;
  saveMemory(memory);
  console.log(`[${getName(normalized, contact)}] removed from always-skip.`);
}

// ─── Cancel mode ───────────────────────────────────────────────────────────────

async function cancelMode(): Promise<void> {
  const id = getFlag("--id");
  if (!id) {
    console.error("Usage: --mode cancel --id q-xxx");
    process.exit(1);
  }
  const q = memory.pendingQuestions.find((pq) => pq.id === id);
  if (!q) {
    console.error(`Question ${id} not found`);
    process.exit(1);
  }
  const name = getName(q.handle, memory.contacts[q.handle]);
  memory.pendingQuestions = memory.pendingQuestions.filter(
    (pq) => pq.id !== id,
  );
  saveMemory(memory);
  console.log(`Cancelled question for [${name}]: "${q.questions[0]}"`);
}

// ─── Digest mode ───────────────────────────────────────────────────────────────

async function digestMode(): Promise<void> {
  const date = new Date().toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const data = buildDigestData(memory, getName);
  const blocks = buildDigestBlocks(data, date);

  // Always print to stdout first
  console.log(`\n=== Morning Digest — ${date} ===`);
  console.log(`Pending questions: ${data.pending.length}`);
  if (data.pending.length) {
    for (const q of data.pending.slice(0, 10)) {
      const age = Math.floor(
        (Date.now() - new Date(q.askedAt).getTime()) / 3600000,
      );
      console.log(
        `  [${q.name}] "${q.preview}"${q.draftReply ? ` — draft ready` : ""} (${age < 24 ? age + "h" : Math.floor(age / 24) + "d"} ago)`,
      );
      console.log(
        `    → bun run agent.ts --mode answer --id ${q.id} --answer "yes"`,
      );
    }
    if (data.pending.length > 10)
      console.log(`  … and ${data.pending.length - 10} more`);
  } else {
    console.log("  Inbox clean.");
  }

  if (data.unrepliedProspects.length) {
    console.log(
      `\nBMA prospects with no recent contact: ${data.unrepliedProspects.length}`,
    );
    for (const p of data.unrepliedProspects) {
      console.log(
        `  [${p.name}] — ${p.daysSince === 999 ? "never contacted" : `${p.daysSince}d ago`}`,
      );
    }
  }

  const sentToSlack = await sendDigestToSlack(blocks);
  if (sentToSlack) {
    console.log("\n✓ Digest sent to Slack");
  } else {
    console.log(
      "\n(Set SLACK_WEBHOOK_URL to push this to Slack automatically)",
    );
  }
}

// ─── Chat mode ─────────────────────────────────────────────────────────────────

async function chatMode(): Promise<void> {
  const handle = getFlag("--handle");
  if (!handle) {
    console.error("Usage: --mode chat --handle +13104296285");
    process.exit(1);
  }
  const normalized = normalizeHandle(handle);
  const contact = memory.contacts[normalized];
  const name = getName(normalized, contact);

  // Pull full thread from chat.db
  let thread: Message[] = [];
  try {
    const result = await sdk.getMessages({
      sender: normalized,
      limit: 30,
      excludeReactions: true,
    });
    thread = (result?.messages || []) as Message[];
  } catch (err: any) {
    console.error(`SDK error: ${err.message}`);
  }

  // Header
  console.log(`\n=== ${name} (${normalized}) ===`);

  // Memory profile
  if (contact) {
    const fields = [
      contact.relationship && `Relationship: ${contact.relationship}`,
      contact.vibe && `Vibe: ${contact.vibe}`,
      contact.howCalebtexts && `How Caleb texts them: ${contact.howCalebtexts}`,
      contact.trustScore && `Trust: ${(contact.trustScore * 100).toFixed(0)}%`,
      contact.sentCount && `Sent: ${contact.sentCount} messages`,
      contact.autoReplyOk && `Auto-reply: approved`,
      contact.alwaysSkip && `Status: ALWAYS SKIP (${contact.skipReason})`,
      (contact.recentTopics?.length ?? 0) > 0 &&
        `Topics: ${contact.recentTopics!.join(", ")}`,
      (contact.notes?.length ?? 0) > 0 &&
        `Notes: ${contact.notes!.join(" | ")}`,
    ].filter(Boolean);
    if (fields.length) {
      console.log("\nProfile:");
      fields.forEach((f) => console.log(`  ${f}`));
    }
  }

  // Clay CRM profile
  const clay = await getClayProfile(normalized);
  if (clay) {
    console.log("\nClay CRM:");
    clay.split("\n").forEach((l) => console.log(`  ${l}`));
  } else if (process.env.CLAY_API_KEY) {
    console.log("\nClay: not found in table");
  }

  // Pending questions for this contact
  const pending = memory.pendingQuestions.filter(
    (q) => q.handle === normalized && !q.answered,
  );
  if (pending.length) {
    console.log(`\nPending (${pending.length}):`);
    for (const q of pending) {
      console.log(`  [${q.id}] "${q.messagePreview}"`);
      if (q.draftReply) console.log(`    Draft: "${q.draftReply}"`);
      console.log(`    → --mode answer --id ${q.id} --answer "yes"`);
    }
  }

  // Thread
  if (!thread.length) {
    console.log("\n(No messages found)");
    return;
  }
  const sorted = [...thread].sort(
    (a, b) => a.date.getTime() - b.date.getTime(),
  );
  console.log(`\nThread (last ${sorted.length}):`);
  for (const m of sorted) {
    const ts = m.date.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    const speaker = m.isFromMe ? "Caleb" : name;
    const text = m.text || "[media]";
    console.log(`  [${ts}] ${speaker}: ${text.slice(0, 200)}`);
  }
}

// ─── Server mode (Loop Message webhook) ────────────────────────────────────────

async function sendViaLoop(
  to: string,
  message: string,
  payload?: any,
): Promise<void> {
  const apiKey = process.env.LOOP_API_KEY;
  const sender = process.env.LOOP_SENDER_ID;
  if (!apiKey || !sender) {
    console.warn("[loop] LOOP_API_KEY or LOOP_SENDER_ID not set");
    return;
  }

  const isGroup = !!(payload?.group_id || payload?.chat_id);
  const body: any = {
    recipient: to,
    message,
    sender_id: sender,
  };
  if (isGroup && (payload?.group_id || payload?.chat_id)) {
    body.group_id = payload.group_id ?? payload.chat_id;
  }

  const r = await fetch("https://api.loopmessage.com/message/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Loop send failed HTTP ${r.status}: ${text.slice(0, 200)}`);
  }
}

async function serverMode(): Promise<void> {
  const PORT = parseInt(process.env.PORT ?? "8080");
  const SECRET = process.env.WEBHOOK_SECRET;
  const { anthropic } = await initAI();

  console.log(`[server] Starting webhook server on port ${PORT}`);
  if (!process.env.LOOP_API_KEY)
    console.warn("[server] LOOP_API_KEY not set -- cannot send replies");

  const CRISIS_RE =
    /\b(kill(ing)? (my|him|her|them)?self|suicid(al|e)|want to die|end (my|this) life|hurt(ing)? (my|him|her|them)?self|in danger|emergency|help me|call 911|abuse|he hit|she hit|being (hurt|abused))\b/i;

  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          provider: _provider,
          contacts: contactCount(),
        }),
      );
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return;
    }

    // Optional webhook secret
    if (SECRET) {
      const auth = req.headers["authorization"] ?? "";
      const qs =
        new URL(req.url ?? "", `http://localhost:${PORT}`).searchParams.get(
          "secret",
        ) ?? "";
      if (auth !== `Bearer ${SECRET}` && qs !== SECRET) {
        res.writeHead(401);
        res.end("Unauthorized");
        return;
      }
    }

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", async () => {
      res.writeHead(200);
      res.end("ok");
      try {
        const payload = JSON.parse(body);
        if (
          payload.event !== "message_inbound" ||
          !payload.text ||
          !payload.contact
        )
          return;
        const from = payload.contact as string;
        const text = payload.text as string;

        if (
          normalizeHandle(from) ===
          normalizeHandle(process.env.CALEB_PHONE ?? "")
        )
          return; // skip own echoes

        const handle = normalizeHandle(from);
        const contact = getOrCreateContact(memory, handle);
        syncName(handle, contact);

        // Intent classification — catch hard signals before LLM triage
        const intent = classifyIntent(text);
        if (intent.type === "stop") {
          markAlwaysSkip(memory, handle, "user sent STOP");
          saveMemory(memory);
          if (db) {
            await db
              .markAlwaysSkip(handle, "stop intent from message")
              .catch(() => {});
          }
          console.log(`[server] STOP from ${from} — marked always-skip`);
          return;
        }

        if (CRISIS_RE.test(text)) {
          console.log(
            `[server] Crisis signal from ${from}: "${text.slice(0, 100)}"`,
          );
          if (process.env.SLACK_WEBHOOK_URL) {
            postSlack(
              process.env.SLACK_WEBHOOK_URL,
              `URGENT: ${from} may need help. Message: "${text.slice(0, 200)}"`,
            ).catch(() => {});
          }
          await sendViaLoop(
            from,
            "Hey, I hear you. That sounds really hard. Please reach out to someone who can be there with you -- the 988 Suicide and Crisis Lifeline (call or text 988) is available 24/7.",
            payload,
          );
          return;
        }

        // Triage
        const msgs: any[] = [
          {
            text,
            date: new Date(),
            isFromMe: false,
            isGroupChat: false,
            isReaction: false,
          },
        ];
        const pf = preFilter(msgs);
        if (pf) return; // OTP, spam, LinkedIn -- skip silently

        const t = await triage(
          anthropic,
          handle,
          msgs,
          contact,
          _provider === "ollama" || _anthropicDead,
        );
        if (t.action === "skip") return;

        if (t.action === "ask_caleb") {
          addPendingQuestion(
            memory,
            handle,
            text,
            t.questionForCaleb ?? "How should you reply?",
          );
          saveMemory(memory);
          // Notify Caleb via Slack if configured
          if (process.env.SLACK_WEBHOOK_URL) {
            postSlack(
              process.env.SLACK_WEBHOOK_URL,
              `[${getName(handle, contact)}] "${text.slice(0, 200)}" -- needs your reply`,
            ).catch(() => {});
          }
          return;
        }

        // auto_reply
        if (!anthropic || _anthropicDead) return; // can't generate without Anthropic

        // Check if this contact is in GPT-chat conversational mode
        if (db && process.env.ANTHROPIC_API_KEY) {
          try {
            const dbContact = await db.getOrCreateContact(handle);
            if (dbContact.conversation_mode === "gpt_chat") {
              const session = await getOrBootstrapSession(
                dbContact,
                process.env.AGENT_USER_ID!,
                db,
              );
              const ctx: ConvoContext = {
                user: {
                  display_name: "Caleb",
                  persona:
                    "Caleb Newton, USC sophomore, serial entrepreneur, 20yo. Short texts, lowercase, no fluff.",
                  own_handles: [...CALEB_HANDLES],
                },
                contact: dbContact,
                session,
              };
              const convoResult = await generateConvoReply(
                text,
                ctx,
                db,
                process.env.ANTHROPIC_API_KEY,
              );
              const quality = checkReplyQuality(convoResult.text);
              if (!quality.ok || !isSafe(convoResult.text)) {
                addPendingQuestion(
                  memory,
                  handle,
                  text,
                  "GPT-chat draft failed quality check",
                );
                saveMemory(memory);
                return;
              }
              const renderedConvo = renderForIMessage(convoResult.text);
              await sendViaLoop(from, renderedConvo, payload);
              await db
                .recordSent({
                  toHandle: handle,
                  message: renderedConvo,
                  conversationMode: true,
                  sessionId: session.id,
                })
                .catch(() => {});
              recordSent(memory, handle, renderedConvo, "gpt_chat", false);
              saveMemory(memory);
              console.log(
                `[server] gpt_chat reply to ${from}: "${renderedConvo.slice(0, 60)}"`,
              );
              return;
            }
          } catch (err: any) {
            // DB error — fall through to standard reply path
            console.error(`[server] DB error, falling back: ${err.message}`);
          }
        }

        // Standard reply path
        const reply = await generateReply(anthropic, msgs, contact);
        if (!reply || !isSafe(reply)) return;
        const rendered = renderForIMessage(reply);

        await sendViaLoop(from, rendered, payload);
        recordSent(memory, handle, rendered, t.reason || "auto_reply", false);
        updateContactAsync(anthropic, handle, msgs, rendered);
        saveMemory(memory);
        console.log(`[server] Replied to ${from}: "${rendered.slice(0, 60)}"`);
      } catch (err: any) {
        console.error(`[server] Error: ${err.message}`);
      }
    });
  });

  server.listen(PORT, () => console.log(`[server] Listening on port ${PORT}`));
  // Keep alive
  await new Promise(() => {});
}

// ─── Entry ─────────────────────────────────────────────────────────────────────

try {
  switch (mode) {
    case "scan":
      await scanMode();
      break;
    case "inbox":
      await showInbox();
      break;
    case "run":
      await runAgent();
      break;
    case "clean":
      await cleanMode();
      break;
    case "skip":
      await skipMode();
      break;
    case "unskip":
      await unskipMode();
      break;
    case "cancel":
      await cancelMode();
      break;
    case "send":
      await sendMode();
      break;
    case "answer":
      await answerMode();
      break;
    case "digest":
      await digestMode();
      break;
    case "chat":
      await chatMode();
      break;
    case "style": {
      const { anthropic } = await initAI();
      await analyzeStyle(anthropic);
      break;
    }
    case "server":
      await serverMode();
      break;
    default:
      console.error(
        `Unknown mode: "${mode}". Valid: scan, inbox, run, style, answer, send, clean, skip, unskip, cancel, digest, chat, server`,
      );
      process.exit(1);
  }
} catch (err: any) {
  console.error("\n[error]", err.message);
  if (DEBUG) console.error(err.stack);
} finally {
  await sdk.close().catch(() => {});
  saveMemory(memory);
}
