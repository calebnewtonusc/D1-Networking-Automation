import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CONFIG_DIR = join(homedir(), ".d1-networking");
const TABLES_FILE = join(CONFIG_DIR, "tables.json");
const USAGE_FILE = join(CONFIG_DIR, "usage.json");
const LISTENER_FILE = join(CONFIG_DIR, "listener.json");

function ensureDir(): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(path: string, data: unknown): void {
  ensureDir();
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

export interface ClayTable {
  name: string;
  webhookUrl: string;
  authKey?: string;
  description?: string;
  createdAt: string;
  rowLimit: number;
}

interface TablesStore {
  tables: Record<string, ClayTable>;
}

export interface UsageEntry {
  count: number;
  lastFired: string;
  limit: number;
}

interface UsageStore {
  tables: Record<string, UsageEntry>;
}

export interface ListenerState {
  pid: number;
  port: number;
  tunnelUrl: string;
  startedAt: string;
}

export function loadTables(): TablesStore {
  return readJson<TablesStore>(TABLES_FILE, { tables: {} });
}

function saveTables(store: TablesStore): void {
  writeJson(TABLES_FILE, store);
}

export function getTable(name: string): ClayTable | null {
  return loadTables().tables[name] ?? null;
}

export function addTable(table: ClayTable): void {
  const store = loadTables();
  store.tables[table.name] = table;
  saveTables(store);
}

export function removeTable(name: string): boolean {
  const store = loadTables();
  if (!store.tables[name]) return false;
  delete store.tables[name];
  saveTables(store);
  return true;
}

export function updateTable(
  name: string,
  updates: Partial<ClayTable>,
): ClayTable | null {
  const store = loadTables();
  const existing = store.tables[name];
  if (!existing) return null;
  const updated = { ...existing, ...updates, name };
  store.tables[name] = updated;
  saveTables(store);
  return updated;
}

export function loadUsage(): UsageStore {
  return readJson<UsageStore>(USAGE_FILE, { tables: {} });
}

function saveUsage(store: UsageStore): void {
  writeJson(USAGE_FILE, store);
}

export function getUsage(tableName: string): UsageEntry {
  const store = loadUsage();
  return store.tables[tableName] ?? { count: 0, lastFired: "", limit: 50000 };
}

export function incrementUsage(tableName: string, limit: number): UsageEntry {
  const store = loadUsage();
  const entry = store.tables[tableName] ?? { count: 0, lastFired: "", limit };
  entry.count += 1;
  entry.lastFired = new Date().toISOString();
  entry.limit = limit;
  store.tables[tableName] = entry;
  saveUsage(store);
  return entry;
}

export function incrementUsageBulk(
  tableName: string,
  limit: number,
  amount: number,
): UsageEntry {
  const store = loadUsage();
  const entry = store.tables[tableName] ?? { count: 0, lastFired: "", limit };
  entry.count += amount;
  entry.lastFired = new Date().toISOString();
  entry.limit = limit;
  store.tables[tableName] = entry;
  saveUsage(store);
  return entry;
}

export function resetUsage(tableName: string, limit: number): void {
  const store = loadUsage();
  store.tables[tableName] = { count: 0, lastFired: "", limit };
  saveUsage(store);
}

export function loadListenerState(): ListenerState | null {
  return readJson<ListenerState | null>(LISTENER_FILE, null);
}

export function saveListenerState(state: ListenerState): void {
  writeJson(LISTENER_FILE, state);
}

export function clearListenerState(): void {
  writeJson(LISTENER_FILE, null);
}

export { CONFIG_DIR };
