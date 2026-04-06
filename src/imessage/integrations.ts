/**
 * External Integrations — all optional, zero crash on missing env vars.
 *
 * Enable each integration by setting the relevant env vars in .env:
 *
 *   SLACK_WEBHOOK_URL        Morning digest → your Slack DM or #inbox channel
 *   BMA_SLACK_WEBHOOK        BMA prospect replies → routed to Kevin / deal team channel
 *   BMA_PROSPECT_KEYWORDS    Comma-separated keywords that flag a contact as a prospect
 *                            e.g. "investor,founder,bd,deal,raise" (default: "bma")
 *   FIRESTORE_PROJECT_ID     GCP project — logs every interaction to imessage_interactions collection
 *   FIRESTORE_SA_KEY         Path to GCP service account JSON (needs Firestore read/write)
 *   CLAY_API_KEY             Clay API key — enriches contacts with CRM data
 *   CLAY_TABLE_ID            Clay source/table ID that holds your prospect list
 */

import { createSign }                        from 'node:crypto'
import { readFileSync, existsSync }          from 'node:fs'
import type { ContactProfile, AgentMemory }  from './memory.ts'

// ─── Slack ─────────────────────────────────────────────────────────────────────

/** Returns true if the message was delivered successfully. */
export async function postSlack(url: string, text: string, blocks?: any[]): Promise<boolean> {
  // Never send an empty payload — Slack rejects it
  const hasBlocks = blocks && blocks.length > 0
  if (!hasBlocks && !text.trim()) return false

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(hasBlocks ? { blocks } : { text }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!r.ok) { console.error(`[slack] HTTP ${r.status}`); return false }
    return true
  } catch (err: any) {
    console.error(`[slack] ${err.message}`)
    return false
  }
}

/**
 * Sends the morning digest to SLACK_WEBHOOK_URL.
 * Returns false if no webhook configured OR if delivery failed.
 */
export async function sendDigestToSlack(blocks: any[]): Promise<boolean> {
  const url = process.env.SLACK_WEBHOOK_URL
  if (!url) return false
  return postSlack(url, '', blocks)
}

// ─── BMA Prospect Classifier ───────────────────────────────────────────────────

const BMA_KEYWORDS = (process.env.BMA_PROSPECT_KEYWORDS || 'bma,prospect,investor,bd,deal')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)

export function isBmaProspect(contact: ContactProfile): boolean {
  if (contact.relationship === 'bma') return true
  const text = [(contact.vibe || ''), (contact.relationship || ''), ...(contact.notes || [])].join(' ').toLowerCase()
  return BMA_KEYWORDS.some(k => text.includes(k))
}

export interface ProspectClassification {
  intent: 'interested' | 'not_interested' | 'scheduling' | 'question' | 'objection' | 'other'
  summary: string
  urgency: 'high' | 'normal' | 'low'
}

/** Classify a prospect reply with Haiku, then POST to BMA_SLACK_WEBHOOK. */
export async function routeProspectReply(
  contact: ContactProfile,
  messageText: string,
  anthropic: any | null,
): Promise<void> {
  const url = process.env.BMA_SLACK_WEBHOOK
  if (!url) return

  let classification: ProspectClassification = { intent: 'other', summary: messageText.slice(0, 200), urgency: 'normal' }

  const VALID_INTENTS = new Set(['interested', 'not_interested', 'scheduling', 'question', 'objection', 'other'])
  const VALID_URGENCIES = new Set(['high', 'normal', 'low'])

  if (anthropic) {
    try {
      const res = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 120,
        messages: [{
          role: 'user',
          content: `Classify this iMessage reply from a BMA/sales prospect. Return JSON only.\n{"intent":"interested|not_interested|scheduling|question|objection|other","summary":"1 sentence","urgency":"high|normal|low"}\nMESSAGE: "${messageText.slice(0, 500)}"`,
        }],
      })
      const text = (res.content[0]?.text || '').trim()
      const json = (() => { try { return JSON.parse(text) } catch { return null } })()
      // Validate each field before trusting model output — never let bad JSON corrupt classification
      if (json) classification = {
        intent:  VALID_INTENTS.has(json.intent)     ? json.intent   : classification.intent,
        summary: typeof json.summary === 'string'   ? json.summary.slice(0, 300) : classification.summary,
        urgency: VALID_URGENCIES.has(json.urgency)  ? json.urgency  : classification.urgency,
      }
    } catch {}
  }

  const name   = contact.displayName || contact.handle
  const emoji  = { interested: '🟢', not_interested: '🔴', scheduling: '📅', objection: '🟡', question: '❓', other: '⚪' }[classification.intent] ?? '⚪'
  const urgent = classification.urgency === 'high' ? ' 🔥' : ''

  // Truncate all user-controlled strings — Slack rejects blocks where any text field > 3000 chars
  const safeName    = name.slice(0, 100)
  const safeSummary = classification.summary.slice(0, 500)
  const safeMsg     = messageText.slice(0, 1000)

  await postSlack(url, '', [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `${emoji} *BMA Prospect Reply${urgent}*\n*From:* ${safeName} (${contact.handle})\n*Intent:* ${classification.intent}` },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Summary:* ${safeSummary}` },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Full message:* "${safeMsg}"` },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Reply: \`bun run agent.ts --mode answer --id <q-id> --answer "your reply"\`` }],
    },
  ])
}

// ─── Firestore ─────────────────────────────────────────────────────────────────
// Uses Firestore REST API with service account JWT — no npm package needed.

let _firestoreToken: string | null = null
let _firestoreTokenExpiry          = 0

async function getFirestoreToken(): Promise<string | null> {
  const keyPath = process.env.FIRESTORE_SA_KEY
  if (!keyPath) return null
  if (!existsSync(keyPath)) {
    console.error(`[firestore] SA key not found: ${keyPath}`)
    return null
  }
  // Return cached token if still valid (refresh 100s before expiry)
  if (_firestoreToken && Date.now() < _firestoreTokenExpiry) return _firestoreToken

  try {
    const sa  = JSON.parse(readFileSync(keyPath, 'utf-8'))
    if (!sa.private_key || !sa.client_email) throw new Error('SA JSON missing private_key or client_email')
    const now = Math.floor(Date.now() / 1000)
    const b64 = (s: string) => Buffer.from(s).toString('base64url')

    const header  = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
    const payload = b64(JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/datastore',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now, exp: now + 3600,
    }))

    const signer = createSign('RSA-SHA256')
    signer.update(`${header}.${payload}`)
    const sig = signer.sign(sa.private_key, 'base64url')

    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${header}.${payload}.${sig}`,
      signal: AbortSignal.timeout(10_000),
    })
    if (!r.ok) throw new Error(`OAuth ${r.status}: ${await r.text()}`)
    const data = await r.json() as any
    if (!data.access_token) throw new Error('OAuth response missing access_token')
    _firestoreToken       = data.access_token as string
    // expires_in defaults to 3600s if missing; subtract 100s buffer to avoid using an expiring token
    _firestoreTokenExpiry = Date.now() + ((Number(data.expires_in) || 3600) - 100) * 1000
    return _firestoreToken
  } catch (err: any) {
    console.error(`[firestore] Auth failed: ${err.message}`)
    return null
  }
}

/** Log an iMessage interaction to Firestore `imessage_interactions` collection. Fire-and-forget. */
export async function logInteraction(
  handle: string,
  displayName: string | undefined,
  message: string,
  direction: 'inbound' | 'outbound',
  context: string,
): Promise<void> {
  const projectId = process.env.FIRESTORE_PROJECT_ID
  if (!projectId) return

  const token = await getFirestoreToken()
  if (!token) return

  try {
    const r = await fetch(
      `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/imessage_interactions`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: {
            handle:      { stringValue: handle },
            displayName: { stringValue: displayName || handle },
            message:     { stringValue: message.slice(0, 2000) },
            direction:   { stringValue: direction },
            context:     { stringValue: context },
            timestamp:   { timestampValue: new Date().toISOString() },
          },
        }),
        signal: AbortSignal.timeout(10_000),
      },
    )
    if (!r.ok && process.env.DEBUG) {
      console.error(`[firestore] Write failed HTTP ${r.status}`)
    }
  } catch (err: any) {
    if (process.env.DEBUG) console.error(`[firestore] ${err.message}`)
  }
}

// ─── Clay ──────────────────────────────────────────────────────────────────────
// Clay v2 REST API — https://docs.clay.com/api-reference

export interface ClayRow {
  id?: string
  name?: string
  phone?: string
  email?: string
  company?: string
  title?: string
  linkedinUrl?: string
  [key: string]: unknown
}

/** Search Clay table by phone number. Returns the first matching row or null. */
export async function lookupClayContact(phone: string): Promise<ClayRow | null> {
  const key     = process.env.CLAY_API_KEY
  const tableId = process.env.CLAY_TABLE_ID
  if (!key || !tableId) return null

  try {
    // Clay v2 row search — adjust endpoint if your Clay version differs
    const r = await fetch(
      `https://api.clay.com/v2/tables/${tableId}/rows?query=${encodeURIComponent(phone)}&limit=1`,
      {
        headers: { Authorization: `Bearer ${key}`, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10_000),
      },
    )
    if (!r.ok) {
      if (process.env.DEBUG) console.error(`[clay] HTTP ${r.status} for ${phone}`)
      return null
    }
    const data = await r.json() as any
    // Clay returns rows under various shapes depending on version
    const row = data.rows?.[0] ?? data.data?.[0] ?? (Array.isArray(data) ? data[0] : null)
    return row ?? null
  } catch (err: any) {
    if (process.env.DEBUG) console.error(`[clay] ${err.message}`)
    return null
  }
}

/** Returns a formatted one-paragraph Clay profile for a phone number, or null if not found. */
export async function getClayProfile(phone: string): Promise<string | null> {
  const row = await lookupClayContact(phone)
  if (!row) return null

  const parts = [
    row.name     && `Name: ${row.name}`,
    row.title    && `Title: ${row.title}`,
    row.company  && `Company: ${row.company}`,
    row.email    && `Email: ${row.email}`,
    row.linkedinUrl && `LinkedIn: ${row.linkedinUrl}`,
    // Include any extra top-level string fields that look useful
    ...Object.entries(row)
      .filter((entry): entry is [string, string] => {
        const [k, v] = entry
        return !['id','name','title','company','email','phone','linkedinUrl'].includes(k) &&
          typeof v === 'string' && v.length > 0 && v.length < 200
      })
      .slice(0, 5)
      .map(([k, v]) => `${k}: ${v}`),
  ].filter(Boolean)

  return parts.length ? parts.join('\n') : null
}

// ─── Digest builder ────────────────────────────────────────────────────────────

export interface DigestData {
  pending: Array<{ id: string; handle: string; name: string; preview: string; draftReply?: string; askedAt: string }>
  unrepliedProspects: Array<{ handle: string; name: string; lastContacted: string; daysSince: number }>
  stats: { totalSent: number; totalRuns: number; pendingCount: number }
}

/** Build the digest payload from memory — no SDK calls needed. */
export function buildDigestData(memory: AgentMemory, getName: (h: string, c?: ContactProfile) => string): DigestData {
  // Sort oldest-asked first — people who've been waiting longest are highest priority
  const pending = memory.pendingQuestions
    .filter(q => !q.answered)
    .sort((a, b) => new Date(a.askedAt).getTime() - new Date(b.askedAt).getTime())
    .slice(0, 20)
    .map(q => ({
      id:         q.id,
      handle:     q.handle,
      name:       getName(q.handle, memory.contacts[q.handle]),
      preview:    q.messagePreview.slice(0, 120),
      draftReply: q.draftReply?.slice(0, 120),
      askedAt:    q.askedAt,
    }))

  const sevenDaysAgo = Date.now() - 7 * 86400 * 1000
  const unrepliedProspects = Object.values(memory.contacts)
    .filter(c =>
      isBmaProspect(c) &&
      !c.alwaysSkip &&
      // Include never-contacted prospects AND those last contacted 7+ days ago
      (!c.lastContactedAt || new Date(c.lastContactedAt).getTime() < sevenDaysAgo)
    )
    .map(c => ({
      handle:        c.handle,
      name:          getName(c.handle, c),
      lastContacted: c.lastContactedAt || 'never',
      daysSince:     c.lastContactedAt
        ? Math.floor((Date.now() - new Date(c.lastContactedAt).getTime()) / 86400000)
        : 999,
    }))
    // Sort: never-contacted last (999), then by most recent gap descending
    .sort((a, b) => b.daysSince - a.daysSince)
    .slice(0, 10)

  return {
    pending,
    unrepliedProspects,
    stats: {
      totalSent:    memory.stats.totalSent,
      totalRuns:    memory.stats.totalRuns,
      pendingCount: pending.length,
    },
  }
}

/** Build Slack Block Kit blocks for the morning digest. */
export function buildDigestBlocks(data: DigestData, date: string): any[] {
  const blocks: any[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `📱 iMessage Digest — ${date}` },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `${data.stats.totalSent} texts sent all-time · ${data.stats.totalRuns} agent runs` }],
    },
    { type: 'divider' },
  ]

  if (data.pending.length === 0) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '✅ *No pending questions* — inbox clean.' } })
  } else {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${data.pending.length} Pending Questions*` } })
    for (const q of data.pending.slice(0, 8)) {
      const age    = Math.floor((Date.now() - new Date(q.askedAt).getTime()) / 3600000)
      const ageStr = age < 1 ? 'just now' : age < 24 ? `${age}h ago` : `${Math.floor(age/24)}d ago`
      // Truncate to stay under Slack's 3000-char block text limit
      const preview = q.preview.slice(0, 300)
      const draft   = q.draftReply ? `\n_Draft ready → \`--mode answer --id ${q.id} --answer "yes"\`_` : `\n\`--mode answer --id ${q.id} --answer "your reply"\``
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*${q.name.slice(0, 100)}* (${ageStr})\n"${preview}"${draft}` },
      })
    }
    if (data.pending.length > 8) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `+${data.pending.length - 8} more → run \`--mode inbox\`` }] })
    }
  }

  if (data.unrepliedProspects.length) {
    blocks.push({ type: 'divider' })
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${data.unrepliedProspects.length} BMA Prospects — No Recent Contact*` } })
    const lines = data.unrepliedProspects.map(p =>
      `• *${p.name}* — ${p.daysSince === 999 ? 'never contacted' : `${p.daysSince}d ago`}`,
    ).join('\n')
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: lines } })
  }

  blocks.push({ type: 'divider' })
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `Run \`bun run agent.ts --mode inbox\` for full view · \`--mode run\` to process replies` }],
  })

  return blocks
}
