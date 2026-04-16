/**
 * iOS Contacts reader — reads macOS AddressBook SQLite directly.
 * No iCloud API. No sync required. Just Full Disk Access.
 *
 * Returns PersonRecord[] ready to post to Clay.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import Database from "bun:sqlite";
import type { PersonRecord } from "../core/types.js";

const SOURCES_DIR = join(
  homedir(),
  "Library/Application Support/AddressBook/Sources",
);

interface RawPhone {
  fullNumber: string;
  first: string | null;
  last: string | null;
  org: string | null;
  nick: string | null;
  email: string | null;
}

function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length > 11) return `+${digits}`;
  return null;
}

function buildName(
  first: string | null,
  last: string | null,
  nick: string | null,
  org: string | null,
): string {
  return (
    [first, last].filter(Boolean).join(" ").trim() ||
    nick?.trim() ||
    org?.trim() ||
    ""
  );
}

/**
 * Read all contacts from AddressBook and return as PersonRecord[].
 * Each contact with a phone number becomes one record with source: contacts.
 */
export function readContacts(): PersonRecord[] {
  if (!existsSync(SOURCES_DIR)) {
    console.error(
      "[contacts] AddressBook not found — grant Full Disk Access in System Settings",
    );
    return [];
  }

  const now = new Date().toISOString();
  const seen = new Map<string, PersonRecord>();

  for (const source of readdirSync(SOURCES_DIR)) {
    const dbPath = join(SOURCES_DIR, source, "AddressBook-v22.abcddb");
    if (!existsSync(dbPath)) continue;

    try {
      const db = new Database(dbPath, { readonly: true });

      const rows = db
        .query<RawPhone, []>(
          `
        SELECT
          p.ZFULLNUMBER   as fullNumber,
          r.ZFIRSTNAME    as first,
          r.ZLASTNAME     as last,
          r.ZORGANIZATION as org,
          r.ZNICKNAME     as nick,
          (SELECT e.ZADDRESS FROM ZABCDEMAILADDRESS e WHERE e.ZOWNER = r.Z_PK LIMIT 1) as email
        FROM ZABCDPHONENUMBER p
        JOIN ZABCDRECORD r ON p.ZOWNER = r.Z_PK
        WHERE p.ZFULLNUMBER IS NOT NULL
      `,
        )
        .all();

      for (const row of rows) {
        const name = buildName(row.first, row.last, row.nick, row.org);
        if (!name) continue;

        const phone = normalizePhone(row.fullNumber);
        if (!phone) continue;

        const [firstName = "", ...rest] = name.split(" ");
        const email = row.email?.toLowerCase().trim() || undefined;
        const company = row.org?.trim() || undefined;
        const existing = seen.get(phone);

        if (existing) {
          if (!existing.email && email) existing.email = email;
          if (!existing.company && company) existing.company = company;
          continue;
        }

        seen.set(phone, {
          submission_id: phone,
          name,
          first_name: firstName,
          last_name: rest.join(" ") || undefined,
          phone,
          email,
          company,
          sources: ["contacts"],
          imported_at: now,
        });
      }

      db.close();
    } catch (err) {
      console.error(
        `[contacts] failed to read ${source}: ${(err as Error).message}`,
      );
    }
  }

  return Array.from(seen.values());
}
