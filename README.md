# D1 Networking Automation

Your entire network, in one place, synced to Clay.

LinkedIn connections, iMessage threads, and iOS Contacts — pulled together, deduplicated, and pushed to a single Clay table so you always know who you know, how you met, and when you last talked.

---

## What this does

Most people's network is split across three places they never look at together:

- **LinkedIn** — people you've officially connected with
- **iMessage** — people you've actually talked to
- **iOS Contacts** — people who exist in your phone

This tool reads all three and syncs them into a single Clay table. One row per person. Every source tagged. Ready for enrichment, sequencing, or just knowing your network actually exists.

---

## Sources

Pick any combination. Run one or all three.

### LinkedIn

Two modes depending on what you have:

- **CSV export** (fastest): download your Connections.csv from LinkedIn's data export and run `sync linkedin --csv ~/Downloads/Connections.csv`
- **Scrape** (no export needed): runs against your open Chrome session on macOS and scrapes your connections live

Each connection is posted to Clay with: name, LinkedIn URL, company, title, connected date, email (if exported), and `source: linkedin`.

### iMessage

Reads directly from `~/Library/Messages/chat.db` using SQLite. No BlueBubbles. No middleware. Just Full Disk Access and a query.

Extracts: every contact you've texted, resolved against your AddressBook for real names, with last message date and conversation preview. People you've texted but never saved get added as unknowns so you can identify and enrich them in Clay.

Each contact is posted with: phone number, display name (if in AddressBook), last texted date, message count, and `source: imessage`.

### iOS Contacts

Reads your AddressBook directly from the macOS SQLite database at `~/Library/Application Support/AddressBook/`. No iCloud API. No sync required.

Extracts every contact with a phone number or email, including name, organization, and all contact methods. Posted to Clay with `source: contacts`.

---

## Deduplication

All three sources are merged before posting. Matching happens on:

1. Phone number (normalized to E.164)
2. Email address
3. Name similarity (fuzzy, threshold configurable)

A person who is on LinkedIn, in your contacts, AND has texted you becomes one row in Clay with all three sources tagged: `source: linkedin,imessage,contacts`.

---

## Clay table schema

Every row posted to Clay includes:

| Field | Description |
|---|---|
| `submission_id` | Stable unique ID per person (phone, LinkedIn slug, or email) |
| `name` | Display name |
| `phone` | E.164 normalized phone number |
| `email` | Email if known |
| `linkedin_url` | LinkedIn profile URL if known |
| `company` | Current company if known |
| `title` | Current title if known |
| `sources` | Comma-separated: `linkedin`, `imessage`, `contacts` |
| `last_texted_at` | ISO date of last iMessage |
| `message_count` | Total messages exchanged |
| `linkedin_connected_on` | ISO date of LinkedIn connection |
| `imported_at` | When this row was synced |

Clay deduplicates on `submission_id`. Running the sync again only adds new people and updates existing rows.

---

## Setup

```bash
git clone https://github.com/calebnewtonusc/d1-networking-automation
cd d1-networking-automation
npm install
cp .env.example .env
# add CLAY_WEBHOOK_URL to .env
```

---

## Usage

```bash
# Sync all three sources
npm run sync -- --sources linkedin,imessage,contacts

# LinkedIn only (CSV)
npm run sync -- --sources linkedin --csv ~/Downloads/Connections.csv

# iMessage only
npm run sync -- --sources imessage

# iOS Contacts only
npm run sync -- --sources contacts

# Any two
npm run sync -- --sources linkedin,imessage

# Dry run (no Clay posts)
npm run sync -- --sources all --dry-run

# Preview what would be sent
npm run sync -- --sources all --dry-run --verbose
```

---

## Architecture

```
sources/
  linkedin/     CSV parser + AppleScript scraper
  imessage/     chat.db reader (Photon SDK) + AddressBook resolver
  contacts/     AddressBook SQLite reader

core/
  merge.ts      Deduplication across all three sources
  clay.ts       Webhook poster with retry + rate limiting
  config.ts     Persisted state (~/.d1-networking.json)

cli.ts          Commander-based entry point
```

---

## Requirements

- macOS (Full Disk Access required for iMessage and Contacts)
- Node 20+ or Bun
- A Clay account with a webhook source configured

---

All glory to God! ✝️❤️
