/**
 * Merge and deduplicate PersonRecord arrays across multiple sources.
 *
 * Matching priority:
 *   1. Phone number (E.164 normalized)
 *   2. Email address (lowercase)
 *   3. LinkedIn URL slug
 *   4. Exact name match (fallback, lower confidence)
 */
import type { PersonRecord } from "./types.js";

function normalizePhone(raw: string | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length > 11) return `+${digits}`;
  return null;
}

function linkedinSlug(url: string | undefined): string | null {
  if (!url) return null;
  const match = url.match(/\/in\/([^/?#]+)/);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Merge multiple PersonRecord arrays into one deduplicated list.
 * When the same person appears in multiple sources, their records are merged:
 * sources array is unioned, fields are filled in from whichever source has them.
 */
export function mergeRecords(batches: PersonRecord[][]): PersonRecord[] {
  const all = batches.flat();

  // Build lookup indexes
  const byPhone = new Map<string, PersonRecord>();
  const byEmail = new Map<string, PersonRecord>();
  const byLinkedIn = new Map<string, PersonRecord>();
  const byName = new Map<string, PersonRecord>();
  const merged: PersonRecord[] = [];

  for (const record of all) {
    const phone = normalizePhone(record.phone);
    const email = record.email?.toLowerCase().trim();
    const li = linkedinSlug(record.linkedin_url);

    // Find any existing record this matches
    let existing: PersonRecord | undefined;
    if (phone) existing = byPhone.get(phone);
    if (!existing && email) existing = byEmail.get(email);
    if (!existing && li) existing = byLinkedIn.get(li);

    // Name fallback: match only across different sources, and only when the
    // candidate fields don't conflict with an existing record. This catches
    // "same person, LinkedIn CSV has no phone and Contacts has no LinkedIn"
    // without collapsing two different people who share a name.
    if (!existing) {
      const nameKey = record.name.toLowerCase().trim();
      const candidate = byName.get(nameKey);
      if (candidate) {
        const candidateLi = linkedinSlug(candidate.linkedin_url);
        const candidatePhone = normalizePhone(candidate.phone);
        const differentSources = record.sources.some(
          (s) => !candidate.sources.includes(s),
        );
        const liConflict = li && candidateLi && li !== candidateLi;
        const phoneConflict =
          phone && candidatePhone && phone !== candidatePhone;
        if (differentSources && !liConflict && !phoneConflict) {
          existing = candidate;
        }
      }
    }

    if (existing) {
      // Merge into existing
      for (const src of record.sources) {
        if (!existing.sources.includes(src)) existing.sources.push(src);
      }
      // Fill in missing fields
      if (!existing.phone && phone) existing.phone = phone;
      if (!existing.email && email) existing.email = email;
      if (!existing.linkedin_url && record.linkedin_url)
        existing.linkedin_url = record.linkedin_url;
      if (!existing.company && record.company)
        existing.company = record.company;
      if (!existing.title && record.title) existing.title = record.title;
      if (!existing.first_name && record.first_name)
        existing.first_name = record.first_name;
      if (!existing.last_name && record.last_name)
        existing.last_name = record.last_name;
      if (!existing.last_texted_at && record.last_texted_at)
        existing.last_texted_at = record.last_texted_at;
      if (!existing.message_count && record.message_count)
        existing.message_count = record.message_count;
      if (!existing.linkedin_connected_on && record.linkedin_connected_on)
        existing.linkedin_connected_on = record.linkedin_connected_on;
    } else {
      // New record
      const r: PersonRecord = { ...record, phone: phone ?? record.phone };
      merged.push(r);
      existing = r;
    }

    // Update indexes
    const norm = normalizePhone(existing.phone);
    if (norm) byPhone.set(norm, existing);
    if (existing.email) byEmail.set(existing.email.toLowerCase(), existing);
    const slug = linkedinSlug(existing.linkedin_url);
    if (slug) byLinkedIn.set(slug, existing);
    byName.set(existing.name.toLowerCase().trim(), existing);
  }

  // Sort: sources with most connections first, then alphabetical
  return merged.sort((a, b) => {
    if (b.sources.length !== a.sources.length)
      return b.sources.length - a.sources.length;
    return a.name.localeCompare(b.name);
  });
}
