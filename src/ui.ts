import { createInterface } from "node:readline/promises";
import { stripVTControlCharacters } from "node:util";

export const VERSION = "0.2.1";
export const DOG = String.raw`
  ▗██▄▄                      ▄▄██▖
  ██▀▜██▙▄  ▙▄            ▄▟██▛▀██
 ▐█▌   ▀███▄▐██▄        ▄███▀   ▜█▌
 ▐█▌     ███████▙      ▝▀▀▀     ▐█▌
 ██▌   ▄█████████▌              ▐█▌
 ▐█▌ ▄████████████              ▐█▌
 ▐█▙▟████████████▌              ▜█▘
  ▀▝▀▘     ▀▀███▛

         ▄█▙▖          ▄█▙▖
         ▜██▌    ▄▄    ▜██▘
             ▄███▛▜███▄
           ▗███▌    ▐███▖
           █████▄  ▄█████
  ▗▄       ▝▜██▛▀  ▀▜██▛▘       ▄▖
  ▐██▄▖                      ▗▄██▌
  ▟█████▙▄▖              ▗▄▄█████▙
 ▐█▛███████████▄▄▄▄▄▄███████████▜█▌
  ▀ ▝██████████████████████████▘ ▀
     ▝▜██████████████████████▛▘
       ▝▜██████████████████▀▘
          ▀▀▜█▜██████▛█▛▀▘
                ▀▀▀▀
`;

export function redactSecrets(value: string): string {
  return value
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, "[redacted token]")
    .replace(/\bgdk_[a-f0-9]{64}\b/g, "[redacted API key]");
}
// C1 controls and bidirectional overrides can drive or spoof terminals.
const UNSAFE_UNICODE = /[\u0080-\u009f\u202a-\u202e\u2066-\u2069]/g;

export function clean(value: string): string {
  return redactSecrets(
    stripVTControlCharacters(value)
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
      .replace(UNSAFE_UNICODE, ""),
  );
}
/** Escape characters JSON.stringify leaves raw; the JSON value is unchanged. */
export function safeJson(value: unknown): string {
  return redactSecrets(JSON.stringify(value ?? null, null, 2)).replace(
    UNSAFE_UNICODE,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export class Ui {
  constructor(public readonly json = false) {}

  color(text: string, code = 36): string {
    return process.stdout.isTTY &&
      !process.env.NO_COLOR &&
      process.env.TERM !== "dumb"
      ? `\x1b[${code}m${text}\x1b[0m`
      : text;
  }

  banner(): void {
    if (this.json || process.env.GITDOG_NO_BANNER === "1") return;
    process.stdout.write(
      this.color(DOG, 1) + this.color(`  G I T D O G  /  ${VERSION}\n`, 1),
    );
    process.stdout.write("  Your repositories. A very good assistant.\n\n");
  }

  info(message: string): void {
    if (!this.json) process.stderr.write(`${clean(message)}\n`);
  }

  output(value: unknown): void {
    if (this.json) {
      process.stdout.write(`${safeJson(value)}\n`);
      return;
    }
    if (typeof value === "string") {
      process.stdout.write(`${clean(value)}\n`);
      return;
    }
    const record = asRecord(value);
    const rows = Array.isArray(value)
      ? value
      : Array.isArray(record?.items)
        ? record.items
        : undefined;
    if (rows) {
      if (rows.length === 0) {
        process.stdout.write("No results.\n");
      } else {
        const preferred = [
          "path",
          "kind",
          "githubRepo",
          "fullName",
          "githubNumber",
          "githubTitle",
          "name",
          "prefix",
          "scopes",
          "expiresAt",
          "revokedAt",
          "type",
          "githubUsername",
          "title",
          "message",
          "status",
          "indexStatus",
          "role",
          "userRole",
          "_id",
        ];
        const keys = preferred.filter((key) =>
          rows.some((row) => asRecord(row)?.[key] !== undefined),
        );
        if (keys.length > 0)
          this.table(
            rows.map((row) => asRecord(row) ?? {}),
            keys,
          );
        else process.stdout.write(`${clean(JSON.stringify(value, null, 2))}\n`);
      }
      if (typeof record?.total === "number")
        this.info(
          `Showing ${rows.length} of ${record.total}. Use --offset and --limit for more.`,
        );
      if (record?.nextCursor !== undefined && record.nextCursor !== null) {
        this.info(`Next page: --cursor ${JSON.stringify(record.nextCursor)}`);
      }
      if (record?.hasMore === true && record.nextCursor == null)
        this.info("More results are available.");
      return;
    }
    process.stdout.write(
      `${clean(JSON.stringify(value, null, 2) ?? "null")}\n`,
    );
  }

  table(rows: Record<string, unknown>[], keys: string[]): void {
    const cell = (value: unknown) =>
      clean(String(value ?? "—"))
        .replace(/\s+/g, " ")
        .slice(0, 90);
    const widths = keys.map((key) =>
      Math.max(key.length, ...rows.map((row) => cell(row[key]).length)),
    );
    const line = (row: Record<string, unknown>) =>
      keys
        .map((key, i) => cell(row[key]).padEnd(widths[i]))
        .join("  ")
        .trimEnd();
    process.stdout.write(
      this.color(line(Object.fromEntries(keys.map((key) => [key, key]))), 1) +
        "\n",
    );
    rows.forEach((row) => process.stdout.write(`${line(row)}\n`));
  }

  async ask(question: string, fallback?: string): Promise<string> {
    if (this.json || !process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(
        "This command needs input. Supply explicit arguments for non-interactive use.",
      );
    }
    const input = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      const answer = (
        await input.question(
          `${clean(question)}${fallback ? ` (${clean(fallback)})` : ""}: `,
        )
      ).trim();
      if (!answer && fallback) return fallback;
      if (!answer) throw new Error("A value is required.");
      return answer;
    } finally {
      input.close();
    }
  }

  async confirm(message: string, yes = false): Promise<void> {
    if (yes) return;
    const answer = await this.ask(`${message} [y/N]`, "n");
    if (!/^y(es)?$/i.test(answer)) throw new Error("Cancelled.");
  }
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function integer(
  value: string,
  minimum = 1,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const result = Number(value);
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(result) ||
    result < minimum ||
    result > maximum
  ) {
    throw new Error(`Expected an integer between ${minimum} and ${maximum}.`);
  }
  return result;
}
