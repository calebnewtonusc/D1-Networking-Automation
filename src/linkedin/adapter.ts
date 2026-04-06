/**
 * LinkedIn adapter — converts LinkedIn connections (CSV or scraped) into PersonRecord[].
 */
import type { PersonRecord } from "../core/types.js";
import type { LinkedInConnection } from "./parse.js";
import type { ScrapedConnection } from "./scraper-applescript.js";

export function linkedInToRecords(
  connections: (LinkedInConnection | ScrapedConnection)[],
): PersonRecord[] {
  const now = new Date().toISOString();
  return connections.map((c) => ({
    submission_id: c.submissionId,
    name: c.name,
    first_name: c.firstName || undefined,
    last_name: c.lastName || undefined,
    linkedin_url: c.linkedinUrl || undefined,
    email: (c as LinkedInConnection).email || undefined,
    company: c.company || undefined,
    title: c.position || undefined,
    sources: ["linkedin"],
    linkedin_connected_on: c.connectedOn || undefined,
    imported_at: now,
  }));
}
