import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CONFIG_PATH = join(homedir(), ".d1-networking.json");

export interface D1Config {
  clayWebhookUrl?: string;
  lastSyncedAt?: string;
  syncedIds: string[];
}

export function loadConfig(): D1Config {
  if (!existsSync(CONFIG_PATH)) {
    return {
      clayWebhookUrl: process.env.CLAY_WEBHOOK_URL ?? "",
      syncedIds: [],
    };
  }
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {
      clayWebhookUrl: process.env.CLAY_WEBHOOK_URL ?? "",
      syncedIds: [],
    };
  }
}

export function saveConfig(config: D1Config): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}
