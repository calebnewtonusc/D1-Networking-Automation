/**
 * iMessage → PersonRecord adapter.
 * Reads chat.db directly and returns every contact as a PersonRecord
 * with source: imessage. Used for Clay sync — separate from the full agent.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import Database from "bun:sqlite";
import { lookupName, loadContacts } from "./contacts.js";
import type { PersonRecord } from "../core/types.js";

const CHAT_DB = join(homedir(), "Library/Messages/chat.db");

interface RawHandle {
  id: string;
  messageCount: number;
  lastDate: number;
}

function normalizeHandle(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes("@")) return trimmed.toLowerCase();
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return trimmed.toLowerCase();
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  if (/^\d{11}$/.test(digits) && digits.startsWith("1")) return `+${digits}`;
  if (trimmed.startsWith("+")) return trimmed;
  return `+${digits}`;
}

// Apple stores dates as seconds since 2001-01-01
function appleTimeToISO(appleTime: number): string {
  if (!appleTime) return "";
  const unixMs = (appleTime / 1_000_000_000 + 978307200) * 1000;
  return new Date(unixMs).toISOString();
}

export function readIMessageContacts(): PersonRecord[] {
  if (!existsSync(CHAT_DB)) {
    console.error(
      "[imessage] chat.db not found — grant Full Disk Access in System Settings",
    );
    return [];
  }

  loadContacts(); // warm AddressBook cache

  const CALEB_PHONE = normalizeHandle(
    process.env.CALEB_PHONE ?? "+13104296285",
  );
  const CALEB_EMAIL = (
    process.env.CALEB_EMAIL ?? "calebnewtonusc@gmail.com"
  ).toLowerCase();

  let rows: RawHandle[] = [];
  try {
    const db = new Database(CHAT_DB, { readonly: true });
    rows = db
      .query<RawHandle, []>(
        `
      SELECT
        h.id                       as id,
        COUNT(m.rowid)             as messageCount,
        MAX(m.date)                as lastDate
      FROM handle h
      JOIN message m ON m.handle_id = h.rowid
      WHERE h.id IS NOT NULL AND h.id != ''
      GROUP BY h.id
      HAVING messageCount > 0
      ORDER BY lastDate DESC
    `,
      )
      .all();
    db.close();
  } catch (err: unknown) {
    console.error("[imessage] Failed to read chat.db:", (err as Error).message);
    return [];
  }

  const now = new Date().toISOString();
  const records: PersonRecord[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const handle = normalizeHandle(row.id);

    // Skip Caleb's own handles
    if (handle === CALEB_PHONE || handle === CALEB_EMAIL) continue;
    // Skip group chats (contain spaces or are long non-phone strings)
    if (row.id.includes(";+;") || row.id.startsWith("chat")) continue;
    if (seen.has(handle)) continue;
    seen.add(handle);

    const displayName = lookupName(handle);
    const name = displayName || handle;
    const isPhone = handle.startsWith("+");
    const isEmail = handle.includes("@");

    const [firstName = "", ...rest] = name.split(" ");

    records.push({
      submission_id: handle,
      name,
      first_name: displayName ? firstName : undefined,
      last_name: displayName && rest.length ? rest.join(" ") : undefined,
      phone: isPhone ? handle : undefined,
      email: isEmail ? handle : undefined,
      sources: ["imessage"],
      last_texted_at: appleTimeToISO(row.lastDate) || undefined,
      message_count: row.messageCount,
      imported_at: now,
    });
  }

  return records;
}
