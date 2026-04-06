/**
 * Contacts resolver — reads macOS AddressBook sqlite (iCloud source) directly.
 * 917 contacts, loads in ~50ms, cached for the process lifetime.
 *
 * senderName on Message objects is always null in the Photon SDK (hardcoded).
 * This module is the only reliable way to get real names.
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import Database from 'bun:sqlite'

const SOURCES_DIR = join(homedir(), 'Library/Application Support/AddressBook/Sources')

let _cache: Map<string, string> | null = null

/** Load all phone→name + email→name mappings from AddressBook. Cached after first call. */
export function loadContacts(): Map<string, string> {
  if (_cache) return _cache
  _cache = new Map()

  if (!existsSync(SOURCES_DIR)) return _cache

  for (const source of readdirSync(SOURCES_DIR)) {
    const db_path = join(SOURCES_DIR, source, 'AddressBook-v22.abcddb')
    if (!existsSync(db_path)) continue

    try {
      const db = new Database(db_path, { readonly: true })

      // Phone numbers
      const phoneRows = db.query<
        { fullNumber: string; first: string | null; last: string | null; org: string | null; nick: string | null },
        []
      >(`
        SELECT p.ZFULLNUMBER as fullNumber,
               r.ZFIRSTNAME  as first,
               r.ZLASTNAME   as last,
               r.ZORGANIZATION as org,
               r.ZNICKNAME   as nick
        FROM ZABCDPHONENUMBER p
        JOIN ZABCDRECORD r ON p.ZOWNER = r.Z_PK
        WHERE p.ZFULLNUMBER IS NOT NULL
      `).all()

      for (const row of phoneRows) {
        const name = buildName(row.first, row.last, row.nick, row.org)
        if (!name) continue
        const normalized = normalizePhone(row.fullNumber)
        if (normalized) _cache!.set(normalized, name)
      }

      // Email addresses
      const emailRows = db.query<
        { email: string; first: string | null; last: string | null; org: string | null; nick: string | null },
        []
      >(`
        SELECT e.ZADDRESS as email,
               r.ZFIRSTNAME as first,
               r.ZLASTNAME  as last,
               r.ZORGANIZATION as org,
               r.ZNICKNAME  as nick
        FROM ZABCDEMAILADDRESS e
        JOIN ZABCDRECORD r ON e.ZOWNER = r.Z_PK
        WHERE e.ZADDRESS IS NOT NULL
      `).all()

      for (const row of emailRows) {
        const name = buildName(row.first, row.last, row.nick, row.org)
        if (!name || !row.email) continue
        _cache!.set(row.email.toLowerCase().trim(), name)
      }

      db.close()
    } catch {
      // Locked or unavailable — skip this source
    }
  }

  return _cache
}

/** Look up display name for a handle (phone or email). Returns null if not in contacts. */
export function lookupName(handle: string): string | null {
  const contacts = loadContacts()
  // Direct match first
  if (contacts.has(handle)) return contacts.get(handle)!
  // For emails: lowercase lookup
  if (handle.includes('@')) return contacts.get(handle.toLowerCase()) ?? null
  // For phones: try normalized form
  const normalized = normalizePhone(handle)
  if (normalized && contacts.has(normalized)) return contacts.get(normalized)!
  return null
}

/** Total number of contacts loaded */
export function contactCount(): number {
  return loadContacts().size
}

function buildName(
  first: string | null,
  last: string | null,
  nick: string | null,
  org: string | null
): string {
  return [first, last].filter(Boolean).join(' ').trim() || nick?.trim() || org?.trim() || ''
}

function normalizePhone(raw: string): string | null {
  if (!raw) return null
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  if (digits.length > 11) return `+${digits}`
  return null
}
