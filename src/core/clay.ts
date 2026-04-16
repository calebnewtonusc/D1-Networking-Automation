/**
 * Clay webhook poster — works with any PersonRecord[].
 * Rate limited to 10 req/s by default, exponential backoff on 429.
 */
import type { PersonRecord } from "./types.js";

const RETRY_DELAYS = [500, 1000, 2000];

async function postWithRetry(
  url: string,
  body: object,
  attempt = 0,
): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (
      (res.status === 429 || res.status >= 500) &&
      attempt < RETRY_DELAYS.length
    ) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
      return postWithRetry(url, body, attempt + 1);
    }
    return res.ok;
  } catch {
    if (attempt < RETRY_DELAYS.length) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
      return postWithRetry(url, body, attempt + 1);
    }
    return false;
  }
}

export interface PostResult {
  sent: number;
  skipped: number;
  failed: string[];
}

/**
 * Post PersonRecord[] to a Clay webhook.
 * Already-synced IDs (from config) are skipped.
 */
export async function postToClay(
  records: PersonRecord[],
  webhookUrl: string,
  alreadySynced: Set<string>,
  onProgress?: (name: string, status: "sent" | "skipped" | "failed") => void,
  delayMs = 100,
): Promise<PostResult> {
  const result: PostResult = { sent: 0, skipped: 0, failed: [] };

  for (const record of records) {
    if (alreadySynced.has(record.submission_id)) {
      result.skipped++;
      onProgress?.(record.name, "skipped");
      continue;
    }

    const payload = {
      submission_id: record.submission_id,
      name: record.name,
      first_name: record.first_name,
      last_name: record.last_name,
      phone: record.phone,
      email: record.email,
      linkedin_url: record.linkedin_url,
      company: record.company,
      title: record.title,
      sources: record.sources.join(","),
      last_texted_at: record.last_texted_at,
      message_count: record.message_count,
      linkedin_connected_on: record.linkedin_connected_on,
      imported_at: record.imported_at,
    };

    const ok = await postWithRetry(webhookUrl, payload);
    if (ok) {
      result.sent++;
      alreadySynced.add(record.submission_id);
      onProgress?.(record.name, "sent");
    } else {
      result.failed.push(record.name);
      onProgress?.(record.name, "failed");
    }

    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }

  return result;
}
