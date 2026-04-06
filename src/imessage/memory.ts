/**
 * Memory Store v3
 *
 * Fixes from v2:
 * - recordSent no longer increments totalSent on dry runs (separate totalDryRun counter)
 * - addLearning dedup uses smarter 60-char prefix (was 40 — too aggressive)
 * - getCachedResearch default 72h (was 24h — too short for company/person context)
 * - Atomic write now creates backup before overwriting (main + backup = 2 copies)
 * - normalizeHandle('') returns 'unknown' instead of empty string (was causing empty-key contacts)
 * - addPendingQuestion uses questions[] array (was concatenating with " | Also: " = unreadable)
 * - getUnansweredQuestions has a default limit (was returning all, could be thousands)
 * - Contact pruning won't delete contacts missing lastContactedAt (was deleting new contacts)
 * - StyleSnapshot no longer stores rawExamples (privacy — messages saved to disk)
 * - ContactProfile.notes is now string[] (was string — couldn't store multiple)
 * - PendingQuestion stores draftReply for answerMode auto-send
 * - stats now has totalDryRun field
 * - Version migration handles v1 and v2 → v3
 * - setCachedResearch cap raised to 10 entries per contact (was 5)
 * - sentLog cap raised to 2000 (was 1000)
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, copyFileSync } from 'node:fs'

const MEMORY_DIR = join(homedir(), '.imessage-agent')
const MEMORY_PATH = join(MEMORY_DIR, 'memory.json')
const MEMORY_TMP  = join(MEMORY_DIR, 'memory.tmp.json')
const MEMORY_BAK  = join(MEMORY_DIR, 'memory.bak.json')

// ─── Normalization ─────────────────────────────────────────────────────────────

export function normalizeHandle(raw: string): string {
  if (!raw || !raw.trim()) return 'unknown'
  const trimmed = raw.trim()
  if (trimmed.includes('@')) return trimmed.toLowerCase()
  const digits = trimmed.replace(/[^\d]/g, '')
  if (!digits) return trimmed.toLowerCase()
  if (/^\d{10}$/.test(digits)) return `+1${digits}`
  if (/^\d{11}$/.test(digits) && digits.startsWith('1')) return `+${digits}`
  if (trimmed.startsWith('+')) return trimmed
  return `+${digits}`
}

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface ContactProfile {
  handle: string
  displayName?: string
  relationship?: 'friend' | 'bma' | 'family' | 'school' | 'investor' | 'creator' | 'colleague' | 'professor' | 'random'
  vibe?: string
  howCalebtexts?: string
  recentTopics?: string[]
  autoReplyOk: boolean
  alwaysSkip?: boolean
  skipReason?: string
  lastContactedAt?: string
  lastRepliedAt?: string
  sentCount: number
  trustScore: number          // 0–1, grows with each successful auto-reply
  notes?: string[]            // was string — can now hold multiple notes
  isGroup?: boolean
  perplexityCache?: Array<{ query: string; result: string; fetchedAt: string }>
}

export interface StyleSnapshot {
  capturedAt: string
  sampleSize: number
  patterns: {
    avgMessageLength: number
    medianMessageLength: number
    usesLowercase: boolean
    commonOpeners: string[]
    commonClosers: string[]
    emojiUsage: 'none' | 'rare' | 'moderate' | 'heavy'
    punctuationStyle: 'minimal' | 'proper' | 'chaotic'
    characteristicPhrases: string[]
    toneDescriptor: string
  }
  // rawExamples intentionally removed — private messages shouldn't sit on disk in plaintext
}

export interface PendingQuestion {
  id: string
  handle: string
  messagePreview: string
  questions: string[]         // array, not " | Also: " concatenated string
  draftReply?: string         // agent's suggested reply — answerMode can send this
  askedAt: string
  answered: boolean
  answer?: string
}

export interface SentEntry {
  id: string
  to: string
  message: string
  sentAt: string
  context: string
  dryRun: boolean
}

export interface AgentMemory {
  version: number
  updatedAt: string
  contacts: Record<string, ContactProfile>
  styleSnapshot?: StyleSnapshot
  pendingQuestions: PendingQuestion[]
  sentLog: SentEntry[]
  agentLearnings: string[]
  lastRunAt?: string
  stats: {
    totalSent: number
    totalDryRun: number       // new field — dry runs no longer inflate totalSent
    totalSkipped: number
    totalRuns: number
  }
}

// ─── Defaults ──────────────────────────────────────────────────────────────────

export function defaultMemory(): AgentMemory {
  return {
    version: 3,
    updatedAt: new Date().toISOString(),
    contacts: {},
    pendingQuestions: [],
    sentLog: [],
    agentLearnings: [
      'Caleb Newton, USC student, 20. Builds AI startups: Amber (health network), Christlete (prayer app), Playcall, Egats.',
      'Works with BMA (Blue Modern Advisory) — Sagar Tiwari and Karthik are co-founders.',
      'Nathan Chan is a close friend/investor. Plan team dinners, lock-in sessions, retreats.',
      'Caleb texts short, lowercase, direct. No fluff. Uses: yo, bro, lol, fr, bet, lowkey, ngl, been heads down.',
      'Christian faith — genuine, not performative. Prays before big decisions.',
      'Family: mom asks for rides, dad warns about IP. Siblings help with school stuff.',
    ],
    stats: { totalSent: 0, totalDryRun: 0, totalSkipped: 0, totalRuns: 0 },
  }
}

// ─── I/O ───────────────────────────────────────────────────────────────────────

function migrate(raw: any): AgentMemory {
  if (!raw.version || raw.version < 3) {
    raw.version = 3
    raw.stats = raw.stats || {}
    raw.stats.totalSent    = raw.stats.totalSent    || 0
    raw.stats.totalDryRun  = raw.stats.totalDryRun  || 0
    raw.stats.totalSkipped = raw.stats.totalSkipped || 0
    raw.stats.totalRuns    = raw.stats.totalRuns    || 0
    // Migrate pendingQuestions: single question string → questions array
    for (const q of raw.pendingQuestions || []) {
      if (typeof (q as any).question === 'string') {
        q.questions = (q as any).question.split(' | Also: ').filter(Boolean)
        delete (q as any).question
      }
      if (!Array.isArray(q.questions)) q.questions = []
    }
    // Migrate contacts: notes string → notes array
    for (const contact of Object.values(raw.contacts || {}) as any[]) {
      if (typeof contact.notes === 'string') {
        contact.notes = contact.notes ? [contact.notes] : []
      } else if (!contact.notes) {
        contact.notes = []
      }
    }
  }
  return raw as AgentMemory
}

export function loadMemory(): AgentMemory {
  if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true })
  if (!existsSync(MEMORY_PATH)) {
    const m = defaultMemory()
    _write(m)
    return m
  }
  try {
    return migrate(JSON.parse(readFileSync(MEMORY_PATH, 'utf-8')))
  } catch {
    if (existsSync(MEMORY_BAK)) {
      try {
        console.error('[memory] Main file corrupt — restoring from backup')
        return migrate(JSON.parse(readFileSync(MEMORY_BAK, 'utf-8')))
      } catch {}
    }
    console.error('[memory] Corrupt memory + no backup — starting fresh')
    return defaultMemory()
  }
}

function _write(memory: AgentMemory): void {
  if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true })
  if (existsSync(MEMORY_PATH)) {
    try { copyFileSync(MEMORY_PATH, MEMORY_BAK) } catch {}
  }
  writeFileSync(MEMORY_TMP, JSON.stringify(memory, null, 2))
  renameSync(MEMORY_TMP, MEMORY_PATH)
}

export function saveMemory(memory: AgentMemory): void {
  memory.updatedAt = new Date().toISOString()

  // Prune: only remove zero-interaction contacts older than 30 days
  // Must have lastContactedAt set — don't delete freshly-created contacts
  const cutoff = Date.now() - 30 * 86400 * 1000
  for (const [handle, contact] of Object.entries(memory.contacts)) {
    if (
      contact.sentCount === 0 &&
      contact.trustScore === 0 &&
      contact.lastContactedAt &&
      !contact.alwaysSkip &&
      new Date(contact.lastContactedAt).getTime() < cutoff
    ) {
      delete memory.contacts[handle]
    }
  }

  if (memory.sentLog.length > 2000) memory.sentLog = memory.sentLog.slice(-2000)

  const unanswered    = memory.pendingQuestions.filter(q => !q.answered)
  const recentAnswered = memory.pendingQuestions.filter(q => q.answered).slice(-100)
  memory.pendingQuestions = [...unanswered, ...recentAnswered]

  _write(memory)
}

// ─── Contact helpers ───────────────────────────────────────────────────────────

export function getOrCreateContact(memory: AgentMemory, rawHandle: string): ContactProfile {
  const handle = normalizeHandle(rawHandle)
  if (!memory.contacts[handle]) {
    memory.contacts[handle] = {
      handle,
      autoReplyOk: false,
      sentCount: 0,
      trustScore: 0,
      notes: [],
    }
  }
  return memory.contacts[handle]
}

export function markAlwaysSkip(memory: AgentMemory, rawHandle: string, reason: string): void {
  const contact = getOrCreateContact(memory, rawHandle)
  contact.alwaysSkip = true
  contact.skipReason = reason
}

export function recordSent(
  memory: AgentMemory,
  rawHandle: string,
  message: string,
  context: string,
  dryRun: boolean
): void {
  const handle = normalizeHandle(rawHandle)
  const contact = getOrCreateContact(memory, handle)
  contact.sentCount++
  contact.lastRepliedAt = new Date().toISOString()
  contact.trustScore = Math.min(1, contact.trustScore + 0.05)

  memory.sentLog.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    to: handle,
    message,
    sentAt: new Date().toISOString(),
    context,
    dryRun,
  })

  // Dry runs do NOT count as real sends
  if (dryRun) {
    memory.stats.totalDryRun++
  } else {
    memory.stats.totalSent++
  }
}

// ─── Question management ───────────────────────────────────────────────────────

export function addPendingQuestion(
  memory: AgentMemory,
  rawHandle: string,
  messagePreview: string,
  question: string,
  draftReply?: string
): string {
  const handle = normalizeHandle(rawHandle)
  const existing = memory.pendingQuestions.find(q => q.handle === handle && !q.answered)
  if (existing) {
    if (!existing.questions.includes(question)) {
      existing.questions.push(question)
    }
    if (draftReply && !existing.draftReply) existing.draftReply = draftReply
    return existing.id
  }
  const id = `q-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`
  memory.pendingQuestions.push({
    id, handle,
    messagePreview: messagePreview || '[attachment]',
    questions: [question],
    draftReply,
    askedAt: new Date().toISOString(),
    answered: false,
  })
  return id
}

export function getUnansweredQuestions(memory: AgentMemory, limit = 20): PendingQuestion[] {
  return memory.pendingQuestions.filter(q => !q.answered).slice(0, limit)
}

// ─── Research cache ────────────────────────────────────────────────────────────

export function getCachedResearch(
  memory: AgentMemory,
  rawHandle: string,
  query: string,
  maxAgeHours = 72    // was 24 — company/person context stays valid longer
): string | null {
  const contact = memory.contacts[normalizeHandle(rawHandle)]
  if (!contact?.perplexityCache) return null
  const hit = contact.perplexityCache.find(c => c.query === query)
  if (!hit) return null
  if (Date.now() - new Date(hit.fetchedAt).getTime() > maxAgeHours * 3_600_000) return null
  return hit.result
}

export function setCachedResearch(
  memory: AgentMemory,
  rawHandle: string,
  query: string,
  result: string
): void {
  const contact = getOrCreateContact(memory, rawHandle)
  if (!contact.perplexityCache) contact.perplexityCache = []
  contact.perplexityCache = contact.perplexityCache.filter(c => c.query !== query)
  contact.perplexityCache.push({ query, result, fetchedAt: new Date().toISOString() })
  if (contact.perplexityCache.length > 10) contact.perplexityCache = contact.perplexityCache.slice(-10)
}

// ─── Learnings ─────────────────────────────────────────────────────────────────

export function addLearning(memory: AgentMemory, learning: string): void {
  const lower = learning.toLowerCase().trim()
  if (lower.length < 10) return
  // Use 60-char prefix dedup (was 40 — too aggressive, killed valid variations)
  const isDuplicate = memory.agentLearnings.some(l => {
    const existing = l.toLowerCase()
    const prefixLen = Math.min(60, Math.floor(Math.min(lower.length, existing.length) * 0.6))
    return existing.slice(0, prefixLen) === lower.slice(0, prefixLen)
  })
  if (!isDuplicate) {
    memory.agentLearnings.push(learning)
    if (memory.agentLearnings.length > 60) memory.agentLearnings = memory.agentLearnings.slice(-60)
  }
}
