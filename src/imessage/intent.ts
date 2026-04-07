/**
 * Intent Classification Engine
 *
 * Classifies incoming iMessage text into structured intents without an API call.
 * Falls back to LLM for genuinely ambiguous cases.
 *
 * Intent types:
 *   affirmative   yes/yep/sure/sounds good/definitely/i'm in/bet
 *   negative      no/nah/can't/not really/pass/don't think so
 *   stop          stop/unsubscribe/remove me/don't text me/leave me alone
 *   question      asking something directly
 *   command       "remind me", "add this", "send X to Y", "schedule"
 *   preference    "send bullet points", "keep it short", "more detail"
 *   topic_shift   introducing a completely new subject
 *   greeting      hey/hi/hello/yo/what's up/gm/good morning
 *   farewell      bye/later/talk soon/gn/good night/ttyl
 *   reaction      iMessage tapback (liked/loved/laughed at/etc.)
 *   casual        general chit-chat with no extractable intent
 *   unknown       genuinely can't tell
 */

// ─── Types ─────────────────────────────────────────────────────────────────────

export type IntentType =
  | "affirmative"
  | "negative"
  | "stop"
  | "question"
  | "command"
  | "preference"
  | "topic_shift"
  | "greeting"
  | "farewell"
  | "reaction"
  | "casual"
  | "unknown";

export interface Intent {
  type: IntentType;
  confidence: number; // 0–1
  payload: IntentPayload;
  raw: string;
}

export interface IntentPayload {
  action?: string; // for 'command': 'remind', 'schedule', 'send', 'create_task'
  entities?: string[]; // extracted nouns/topics from the command
  format?: string; // for 'preference': 'list' | 'brief' | 'detailed' | 'narrative'
  reactionType?: string; // for 'reaction': 'liked' | 'loved' | 'laughed' | etc.
  topic?: string; // for 'topic_shift': the new topic
  confidence_reason?: string;
}

// ─── Pattern tables ────────────────────────────────────────────────────────────

const AFFIRMATIVE = [
  /^(yes|yep|yeah|yup|ya|yah|ye)\b/i,
  /^(sure|ok|okay|k|kk)\b/i,
  /^(sounds good|sounds great|sounds like a plan)\b/i,
  /^(definitely|absolutely|totally|for sure|fs)\b/i,
  /^(i'?m in|count me in|i'm down|i'm good)\b/i,
  /^(bet|facts|true|word|fr|lgtm|done|will do|on it)\b/i,
  /^(perfect|great|awesome|love that|let'?s do it|let'?s go)\b/i,
  /^(of course|no problem|no worries)\b/i,
  /^(correct|right|exactly|that works|works for me)\b/i,
  /^(confirmed|confirm)\b/i,
  /\b(agreed|agree|same|same here)\b/i,
];

const NEGATIVE = [
  /^(no|nah|nope|naw|na)\b/i,
  /^(can'?t|cannot|won'?t|don'?t think so)\b/i,
  /^(not really|not sure|maybe not|probably not)\b/i,
  /^(pass|hard pass|i'?m good|i'?ll pass)\b/i,
  /^(not happening|no way|absolutely not)\b/i,
  /\b(don'?t want|not interested|not for me)\b/i,
  /^(negative)\b/i,
];

const STOP = [
  /\bstop\b/i,
  /\bunsubscribe\b/i,
  /\bremove me\b/i,
  /\bleave me alone\b/i,
  /don'?t (text|message|contact) me/i,
  /stop (texting|messaging|contacting) me/i,
  /\bopt.?out\b/i,
];

const GREETING = [
  /^(hey|hi|hello|sup|yo|ayo)\b/i,
  /^(what'?s up|what'?s good|wsg|wyd|wassup|waddup)\b/i,
  /^(gm|good morning|good afternoon|good evening|good night|gn)\b/i,
  /^(how are you|how'?s it going|how'?s everything)\b/i,
  /^(morning|afternoon|evening)\b/i,
];

const FAREWELL = [
  /^(bye|goodbye|later|peace|take care|ttyl|ttys)\b/i,
  /^(talk (soon|later|tomorrow))\b/i,
  /^(catch you later|see you|cya|see ya)\b/i,
  /^(gn|good night|night|nite)\b/i,
  /^(gotta go|gtg|i'?m out|heading out)\b/i,
];

// iMessage reaction phrases (the system inserts these)
const REACTION_PHRASES: Record<string, string> = {
  liked: "liked",
  loved: "loved",
  laughed: "laughed",
  emphasized: "emphasized",
  questioned: "questioned",
  disliked: "disliked",
};

const REACTION_RE =
  /^(liked|loved|laughed at|emphasized|questioned|disliked)\s+"(.+)"$/i;

// Commands
const COMMAND_PATTERNS: Array<{ re: RegExp; action: string }> = [
  { re: /\bremind(er)? me\b/i, action: "remind" },
  { re: /\bset a reminder\b/i, action: "remind" },
  { re: /\badd (this|it|that) to todoist\b/i, action: "create_task" },
  { re: /\bcreate a? task\b/i, action: "create_task" },
  { re: /\bschedule (a |this )?(meeting|call|time)\b/i, action: "schedule" },
  { re: /\bsend (this|it|that) to\b/i, action: "forward" },
  { re: /\bforward (this|it)\b/i, action: "forward" },
  { re: /\bsave (this|it|that)\b/i, action: "save_note" },
  { re: /\badd (to|a) note\b/i, action: "save_note" },
  { re: /\bsearch for\b/i, action: "search" },
  { re: /\blook up\b/i, action: "search" },
  { re: /\bcall me\b/i, action: "initiate_call" },
  { re: /\bdrop (your )?location\b/i, action: "share_location" },
];

// Preference statements
const PREFERENCE_PATTERNS: Array<{ re: RegExp; format: string }> = [
  { re: /\b(bullet|bullets|bullet points?|list(s)?)\b/i, format: "list" },
  { re: /\bkeep it (short|brief|quick|concise)\b/i, format: "brief" },
  { re: /\b(tldr|tl;dr|summarize|short version)\b/i, format: "brief" },
  { re: /\bmore (detail|context|info|depth)\b/i, format: "detailed" },
  { re: /\bexplain (it|more|further|in detail)\b/i, format: "detailed" },
  { re: /\bstory ?form\b/i, format: "narrative" },
  { re: /\bno (emoji|emojis)\b/i, format: "no_emoji" },
  { re: /\buse (emoji|emojis)\b/i, format: "emoji" },
  { re: /\bformat(ted)? (as|like|in)\b/i, format: "custom" },
];

// Topic shift signals (standalone topic markers)
const TOPIC_SHIFT_RE =
  /\b(btw|by the way|anyway|changing the subject|random(ly)?|on another note|quick (q|question))\b/i;

// ─── Core classifier ───────────────────────────────────────────────────────────

export function classifyIntent(text: string, isReaction = false): Intent {
  const raw = text?.trim() ?? "";
  if (!raw) return { type: "unknown", confidence: 1, payload: {}, raw };

  // iMessage tapback reactions
  if (isReaction) {
    const match = raw.match(REACTION_RE);
    const reactionType = match?.[1]?.toLowerCase() ?? "liked";
    return {
      type: "reaction",
      confidence: 1,
      payload: { reactionType: REACTION_PHRASES[reactionType] ?? reactionType },
      raw,
    };
  }

  // Hard stop: check first — highest priority
  if (STOP.some((p) => p.test(raw))) {
    return { type: "stop", confidence: 0.97, payload: {}, raw };
  }

  // Preference statement
  for (const { re, format } of PREFERENCE_PATTERNS) {
    if (re.test(raw)) {
      return { type: "preference", confidence: 0.88, payload: { format }, raw };
    }
  }

  // Command
  for (const { re, action } of COMMAND_PATTERNS) {
    if (re.test(raw)) {
      const entities = extractEntities(raw);
      return {
        type: "command",
        confidence: 0.88,
        payload: { action, entities },
        raw,
      };
    }
  }

  // Farewell (check before greeting — "good night" is farewell)
  if (FAREWELL.some((p) => p.test(raw))) {
    return { type: "farewell", confidence: 0.9, payload: {}, raw };
  }

  // Greeting
  if (GREETING.some((p) => p.test(raw))) {
    return { type: "greeting", confidence: 0.9, payload: {}, raw };
  }

  // Question (has ? or starts with a question word)
  const questionScore = scoreQuestion(raw);
  if (questionScore >= 0.75) {
    return { type: "question", confidence: questionScore, payload: {}, raw };
  }

  // Affirmative
  const affScore = scoreAffirmative(raw);
  if (affScore >= 0.75) {
    return { type: "affirmative", confidence: affScore, payload: {}, raw };
  }

  // Negative
  const negScore = scoreNegative(raw);
  if (negScore >= 0.75) {
    return { type: "negative", confidence: negScore, payload: {}, raw };
  }

  // Topic shift
  if (TOPIC_SHIFT_RE.test(raw)) {
    const topic = raw.replace(TOPIC_SHIFT_RE, "").trim();
    return { type: "topic_shift", confidence: 0.78, payload: { topic }, raw };
  }

  // Low-confidence question (partial?)
  if (questionScore >= 0.4) {
    return { type: "question", confidence: questionScore, payload: {}, raw };
  }

  // Longer text with no clear signal = casual
  if (raw.length > 20) {
    return { type: "casual", confidence: 0.65, payload: {}, raw };
  }

  return { type: "unknown", confidence: 0.5, payload: {}, raw };
}

// ─── Scoring helpers ───────────────────────────────────────────────────────────

function scoreAffirmative(text: string): number {
  const matches = AFFIRMATIVE.filter((p) => p.test(text)).length;
  if (matches === 0) return 0;
  // Short messages with a single strong match = high confidence
  if (text.length <= 20 && matches >= 1) return 0.92;
  return 0.75 + Math.min(0.2, matches * 0.05);
}

function scoreNegative(text: string): number {
  const matches = NEGATIVE.filter((p) => p.test(text)).length;
  if (matches === 0) return 0;
  if (text.length <= 20 && matches >= 1) return 0.9;
  return 0.75 + Math.min(0.2, matches * 0.05);
}

function scoreQuestion(text: string): number {
  const hasQuestionMark = text.includes("?");
  const QUESTION_WORDS =
    /^(what|when|where|who|why|how|which|can you|could you|do you|did you|will you|would you|are you|is it|is there)\b/i;
  const startsWithQuestion = QUESTION_WORDS.test(text);

  if (hasQuestionMark && startsWithQuestion) return 0.97;
  if (hasQuestionMark) return 0.82;
  if (startsWithQuestion) return 0.75;
  return 0;
}

function extractEntities(text: string): string[] {
  // Simple noun phrase extraction: words after prepositions, proper nouns
  const tokens = text.split(/\s+/);
  const stopWords = new Set([
    "the",
    "a",
    "an",
    "to",
    "in",
    "on",
    "at",
    "for",
    "of",
    "with",
    "this",
    "that",
    "it",
  ]);
  return tokens
    .filter(
      (t) =>
        t.length > 2 &&
        !stopWords.has(t.toLowerCase()) &&
        !/^(remind|add|create|schedule|send|forward|save|search|look)\b/i.test(
          t,
        ),
    )
    .slice(0, 5);
}

// ─── Action router ─────────────────────────────────────────────────────────────

export interface IntentAction {
  type:
    | "send_reply"
    | "mark_skip"
    | "create_task"
    | "set_preference"
    | "end_session"
    | "none";
  data?: Record<string, unknown>;
}

/**
 * Given a classified intent and context (what the agent last asked/sent),
 * returns the action to take.
 */
export function routeIntent(
  intent: Intent,
  context: {
    lastBotMessage?: string;
    pendingQuestionId?: string;
    handle: string;
  },
): IntentAction {
  switch (intent.type) {
    case "stop":
      return { type: "mark_skip", data: { reason: "user requested stop" } };

    case "farewell":
      return { type: "end_session" };

    case "affirmative": {
      // If there's a pending question, mark it answered
      if (context.pendingQuestionId) {
        return {
          type: "create_task",
          data: {
            questionId: context.pendingQuestionId,
            answer: "yes",
            sendReply: true,
          },
        };
      }
      return { type: "send_reply", data: { acknowledge: true } };
    }

    case "negative": {
      if (context.pendingQuestionId) {
        return {
          type: "create_task",
          data: {
            questionId: context.pendingQuestionId,
            answer: "no",
            sendReply: true,
          },
        };
      }
      return { type: "send_reply", data: { acknowledge: true } };
    }

    case "preference": {
      return {
        type: "set_preference",
        data: { format: intent.payload.format },
      };
    }

    case "command": {
      if (intent.payload.action === "create_task") {
        return {
          type: "create_task",
          data: { entities: intent.payload.entities },
        };
      }
      return { type: "send_reply", data: { handleCommand: true } };
    }

    case "question":
    case "greeting":
    case "casual":
    case "topic_shift":
      return { type: "send_reply" };

    case "reaction":
    case "unknown":
    default:
      return { type: "none" };
  }
}

// ─── Batch classify messages ───────────────────────────────────────────────────

export function classifyMessages(
  messages: Array<{ text: string | null; is_reaction: boolean }>,
): Intent[] {
  return messages.map((m) => classifyIntent(m.text ?? "", m.is_reaction));
}

// ─── Human-readable summary ────────────────────────────────────────────────────

export function describeIntent(intent: Intent): string {
  const { type, confidence, payload } = intent;
  const pct = Math.round(confidence * 100);
  switch (type) {
    case "affirmative":
      return `Affirmative (${pct}%)`;
    case "negative":
      return `Negative (${pct}%)`;
    case "stop":
      return `Stop/unsubscribe request (${pct}%)`;
    case "question":
      return `Question (${pct}%)`;
    case "command":
      return `Command: ${payload.action ?? "unknown"} (${pct}%)`;
    case "preference":
      return `Preference: ${payload.format ?? "unknown"} (${pct}%)`;
    case "topic_shift":
      return `Topic shift${payload.topic ? ": " + payload.topic : ""} (${pct}%)`;
    case "greeting":
      return `Greeting (${pct}%)`;
    case "farewell":
      return `Farewell (${pct}%)`;
    case "reaction":
      return `Reaction: ${payload.reactionType ?? "liked"} (${pct}%)`;
    case "casual":
      return `Casual (${pct}%)`;
    default:
      return `Unknown (${pct}%)`;
  }
}
