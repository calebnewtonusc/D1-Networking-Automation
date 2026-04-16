import { readFileSync } from "fs";
import { parse } from "csv-parse";

export interface LinkedInConnection {
  submissionId: string;
  firstName: string;
  lastName: string;
  name: string;
  linkedinUrl: string;
  email: string;
  company: string;
  position: string;
  connectedOn: string;
  source: string;
}

/** Find the CSV header row (LinkedIn prepends notes before the real header) */
function findHeaderIndex(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("First Name") || lines[i].includes("FirstName")) {
      return i;
    }
  }
  return 0;
}

function makeId(url: string, first: string, last: string): string {
  if (url.includes("/in/")) {
    const slug = url.split("/in/")[1]?.replace(/\/$/, "");
    if (slug) return `li_${slug}`;
  }
  return `li_${(first + last).toLowerCase().replace(/\s+/g, "")}`;
}

export async function parseLinkedInCsv(
  filePath: string,
): Promise<LinkedInConnection[]> {
  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.split("\n");
  const headerIdx = findHeaderIndex(lines);
  const csvContent = lines.slice(headerIdx).join("\n");

  return new Promise((resolve, reject) => {
    parse(
      csvContent,
      { columns: true, skip_empty_lines: true, trim: true },
      (err, records) => {
        if (err) return reject(err);

        const connections: LinkedInConnection[] = [];
        for (const row of records) {
          const first = row["First Name"] ?? row["FirstName"] ?? "";
          const last = row["Last Name"] ?? row["LastName"] ?? "";
          if (!first && !last) continue;

          const url =
            row["URL"] ?? row["Profile URL"] ?? row["LinkedIn URL"] ?? "";
          const email = row["Email Address"] ?? row["Email"] ?? "";
          const company = row["Company"] ?? row["Company Name"] ?? "";
          const position = row["Position"] ?? row["Title"] ?? "";
          const connectedOn = row["Connected On"] ?? row["ConnectedOn"] ?? "";

          connections.push({
            submissionId: makeId(url, first, last),
            firstName: first,
            lastName: last,
            name: `${first} ${last}`.trim(),
            linkedinUrl: url,
            email,
            company,
            position,
            connectedOn,
            source: "linkedin_export",
          });
        }
        resolve(connections);
      },
    );
  });
}
