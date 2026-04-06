/**
 * Perplexity Client v3
 *
 * Fixes from v2:
 * - Timeout 15s (was 10s — sonar-pro often takes 8-12s)
 * - max_tokens 500 (was 250 — cut off useful research)
 * - Retry once on transient server errors (5xx)
 * - buildResearchQuery accepts ollamaModel + ollamaUrl params (was hardcoded 'llama3.2:latest')
 * - buildPerplexitySystem replaces PERPLEXITY_SYSTEM — takes style + learnings, not a random vibe string
 * - search_recency_filter removed from fixed config (wasn't helping and limits some company queries)
 * - No more console.error pollution on expected failures
 */

const PERPLEXITY_API = 'https://api.perplexity.ai/chat/completions'
const MODEL = 'sonar-pro'

export interface PerplexityResult {
  content: string
  citations?: string[]
}

export async function research(
  query: string,
  systemContext: string,
  apiKey: string | undefined
): Promise<PerplexityResult | null> {
  if (!apiKey || !query) return null
  return _doResearch(query, systemContext, apiKey, 2)
}

async function _doResearch(
  query: string,
  systemContext: string,
  apiKey: string,
  attemptsLeft: number
): Promise<PerplexityResult | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)

  try {
    const response = await fetch(PERPLEXITY_API, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: systemContext },
          { role: 'user', content: query },
        ],
        max_tokens: 500,
        temperature: 0.1,
        return_citations: true,
      }),
    })

    if (!response.ok) {
      // Retry on server errors only
      if (response.status >= 500 && attemptsLeft > 1) {
        clearTimeout(timeout)
        await new Promise(r => setTimeout(r, 1500))
        return _doResearch(query, systemContext, apiKey, attemptsLeft - 1)
      }
      return null
    }

    const data = await response.json() as any
    return {
      content: data.choices?.[0]?.message?.content || '',
      citations: data.citations || [],
    }
  } catch (err: any) {
    if (err.name !== 'AbortError' && attemptsLeft > 1) {
      clearTimeout(timeout)
      await new Promise(r => setTimeout(r, 1500))
      return _doResearch(query, systemContext, apiKey, attemptsLeft - 1)
    }
    return null
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Decide whether to research a contact — uses LLM, no hardcoded rules.
 * Now accepts ollamaModel + ollamaUrl so it uses the right model (was hardcoded llama3.2:latest).
 */
export async function buildResearchQuery(
  messageText: string,
  contactName: string | undefined,
  existingVibe: string | undefined,
  anthropic: any | null,
  model: string,
  ollamaModel = 'llama3.2:latest',
  ollamaUrl = 'http://localhost:11434'
): Promise<string | null> {
  if (messageText.length < 30) return null

  const prompt = `You decide whether to research a contact before replying to their iMessage.

Contact: ${contactName || 'unknown'}
What we know: ${existingVibe || 'nothing'}
Their message: "${messageText.slice(0, 300)}"

If web research would meaningfully help craft a better reply (company background, role, recent news, topic context) — return a concise search query string.
If the message is casual, personal, or needs no external context — return null.

Return ONLY the search query string, or the exact word null. No explanation.`

  try {
    let text: string
    if (anthropic) {
      const resp = await anthropic.messages.create({
        model, max_tokens: 80,
        messages: [{ role: 'user', content: prompt }],
      })
      text = ((resp.content[0] as any).text || '').trim()
    } else {
      const r = await fetch(`${ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: ollamaModel, prompt, stream: false,
          options: { num_predict: 80, temperature: 0.1 },
        }),
        signal: AbortSignal.timeout(15_000),
      })
      const data = await r.json() as any
      text = (data.response || '').trim()
    }
    if (!text || text.toLowerCase() === 'null') return null
    // Take first non-empty line — models sometimes explain after the query
    return text.split('\n').find(l => l.trim())?.trim() || null
  } catch {
    return null
  }
}

/**
 * Build Perplexity system context from Caleb's style + key learnings.
 * Replaces PERPLEXITY_SYSTEM(caleVibe) — was called with agentLearnings[0] which is wrong.
 */
export function buildPerplexitySystem(
  styleSummary: string,
  keyLearnings: string[]
): string {
  const context = keyLearnings.slice(0, 3).join(' ')
  return `Research assistant for Caleb Newton's iMessage agent. ${context} Style: ${styleSummary}. Return 2-4 sentences max. Focus only on what's directly useful for crafting a reply. No fluff.`
}
