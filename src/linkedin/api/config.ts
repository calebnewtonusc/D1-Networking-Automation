import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CONFIG_DIR = join(homedir(), ".d1-networking");
const LI_CONFIG_FILE = join(CONFIG_DIR, "linkedin.json");

export interface LinkedInConfig {
  li_at: string;
  jsessionid: string;
  profile_name?: string;
  profile_urn?: string;
}

export function loadLinkedInConfig(): LinkedInConfig | null {
  try {
    return JSON.parse(readFileSync(LI_CONFIG_FILE, "utf-8")) as LinkedInConfig;
  } catch {
    return null;
  }
}

export function saveLinkedInConfig(config: LinkedInConfig): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(LI_CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
}

export function deleteLinkedInConfig(): void {
  try {
    const { unlinkSync } = require("node:fs");
    unlinkSync(LI_CONFIG_FILE);
  } catch {
    // File doesn't exist
  }
}
