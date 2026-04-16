import {
  getUsage,
  incrementUsage,
  incrementUsageBulk,
  resetUsage,
  loadUsage,
} from "./tables.js";
import { LimitError } from "./errors.js";

const WARNING_THRESHOLD = 0.9;

export function trackFire(tableName: string, limit: number): void {
  const entry = incrementUsage(tableName, limit);
  const ratio = entry.count / entry.limit;

  if (ratio >= 1) {
    throw new LimitError(tableName, entry.count, entry.limit);
  }

  if (ratio >= WARNING_THRESHOLD) {
    const remaining = entry.limit - entry.count;
    console.error(
      `[warn] Table "${tableName}" is at ${entry.count}/${entry.limit} rows (${remaining} remaining).`,
    );
  }
}

export function trackFireBulk(
  tableName: string,
  limit: number,
  amount: number,
): void {
  const entry = incrementUsageBulk(tableName, limit, amount);
  const ratio = entry.count / entry.limit;

  if (ratio >= 1) {
    throw new LimitError(tableName, entry.count, entry.limit);
  }

  if (ratio >= WARNING_THRESHOLD) {
    const remaining = entry.limit - entry.count;
    console.error(
      `[warn] Table "${tableName}" is at ${entry.count}/${entry.limit} rows (${remaining} remaining).`,
    );
  }
}

export function getTableUsage(tableName: string) {
  return getUsage(tableName);
}

export function getAllUsage() {
  return loadUsage();
}

export function resetTableUsage(tableName: string, limit: number) {
  resetUsage(tableName, limit);
}
