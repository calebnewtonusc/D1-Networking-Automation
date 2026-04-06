declare module "node-typedstream" {
  export class NSAttributedString {
    string: string;
  }
  export class Unarchiver {
    static BinaryDecoding: { decodable: unknown };
    static open(buffer: Buffer, mode: unknown): Unarchiver;
    decodeAll(): Array<{ values?: unknown[] } & Record<string, unknown>>;
  }
}

declare module "better-sqlite3" {
  class Database {
    constructor(path: string, options?: { readonly?: boolean });
    prepare(sql: string): Statement;
    close(): void;
  }
  interface Statement {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): void;
  }
  export = Database;
}
