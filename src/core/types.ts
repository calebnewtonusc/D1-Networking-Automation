/**
 * PersonRecord — the unified schema for every person across all sources.
 * Clay deduplicates on submission_id. Running sync again only updates existing rows.
 */
export interface PersonRecord {
  submission_id: string; // stable ID: li_slug, phone, or email
  name: string;
  first_name?: string;
  last_name?: string;
  phone?: string; // E.164 normalized (+13105551234)
  email?: string;
  linkedin_url?: string;
  company?: string;
  title?: string;
  sources: string[]; // e.g. ['linkedin', 'imessage', 'contacts']
  last_texted_at?: string; // ISO date of last iMessage
  message_count?: number; // total messages exchanged
  linkedin_connected_on?: string; // ISO date of LinkedIn connection
  imported_at: string; // ISO date this row was synced
}

export type SourceName = "linkedin" | "imessage" | "contacts";
