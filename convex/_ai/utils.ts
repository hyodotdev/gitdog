type JsonPrefix =
  // The object closes at `end`; anything after it is not part of it.
  | { kind: "complete"; end: number }
  // The text ran out first. `repaired` keeps every finished entry (and a
  // string value cut midway) and closes what is open, or is undefined when
  // nothing was finished.
  | { kind: "cut"; repaired: string | undefined }
  // A grammar error: asking again or closing brackets cannot fix it.
  | { kind: "invalid" };

const CUT = Symbol("cut");
const INVALID = Symbol("invalid");
const LITERAL = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;
const PARTIAL_LITERAL =
  /^(?:-?\d*\.?\d*(?:[eE][+-]?\d*)?|t(?:r(?:ue?)?)?|f(?:a(?:l(?:se?)?)?)?|n(?:u(?:ll?)?)?)$/;

/**
 * Read the JSON object starting at `start` the way JSON.parse would, and say
 * whether it is complete, cut off by the end of the text, or invalid. `\'`
 * is allowed, as models write it.
 */
function readJsonPrefix(text: string, start: number): JsonPrefix {
  let i = start;
  const closers: string[] = [];
  // The last point where every open entry was finished.
  let safe: { end: number; closers: string[] } | undefined;
  // Where the string value being read began its escape, if it is mid-escape.
  let cutString: { end: number } | undefined;
  const markSafe = () => (safe = { end: i, closers: [...closers] });
  const space = () => {
    while (i < text.length && " \t\n\r".includes(text[i])) i++;
    if (i >= text.length) throw CUT;
  };
  const string = (isValue: boolean) => {
    i++;
    while (i < text.length) {
      const char = text[i];
      if (char === '"') return void i++;
      if (char < " ") throw INVALID;
      if (char !== "\\") {
        i++;
        continue;
      }
      const escape = i;
      const code = text[i + 1];
      const length = code === "u" ? 6 : 2;
      if (i + length > text.length) {
        if (isValue) cutString = { end: escape };
        throw CUT;
      }
      if (
        code === "u"
          ? !/^[\da-fA-F]{4}$/.test(text.slice(i + 2, i + 6))
          : !`"\\/bfnrt'`.includes(code)
      )
        throw INVALID;
      i += length;
    }
    if (isValue) cutString = { end: i };
    throw CUT;
  };
  const value = (): void => {
    space();
    const char = text[i];
    if (char === "{" || char === "[") return container(char);
    if (char === '"') return string(true);
    LITERAL.lastIndex = i;
    const literal = LITERAL.exec(text);
    // A literal running to the end of the text may itself be cut short.
    if (literal && i + literal[0].length < text.length)
      return void (i += literal[0].length);
    if (PARTIAL_LITERAL.test(text.slice(i))) throw CUT;
    throw INVALID;
  };
  const container = (open: "{" | "[") => {
    const close = open === "{" ? "}" : "]";
    i++;
    closers.push(close);
    markSafe();
    space();
    if (text[i] === close) {
      i++;
      closers.pop();
      return;
    }
    for (;;) {
      if (open === "{") {
        space();
        if (text[i] !== '"') throw INVALID;
        string(false);
        space();
        if (text[i] !== ":") throw INVALID;
        i++;
      }
      value();
      markSafe();
      space();
      if (text[i] === ",") i++;
      else if (text[i] === close) {
        i++;
        closers.pop();
        return;
      } else throw INVALID;
    }
  };

  try {
    if (text[start] !== "{") return { kind: "invalid" };
    container("{");
    return { kind: "complete", end: i };
  } catch (error) {
    if (error === INVALID) return { kind: "invalid" };
    if (error !== CUT) throw error;
    const repaired = cutString
      ? `${text.slice(0, cutString.end)}"${[...closers].reverse().join("")}`
      : safe &&
        `${text.slice(0, safe.end)}${[...safe.closers].reverse().join("")}`;
    return { kind: "cut", repaired: repaired?.slice(start) };
  }
}

// Where a response's JSON object starts: the response itself when it starts
// with one, otherwise after its first fence when there is one, so braces in
// prose before the fence are skipped. -1 when there is none.
function objectStart(text: string): number {
  if (text.startsWith("{")) return 0;
  const opening = /```[\w-]*\r?\n/.exec(text);
  const fenced = opening ? text.indexOf("{", opening.index) : -1;
  return fenced !== -1 ? fenced : text.indexOf("{");
}

function parseObject(json: string): object | undefined {
  // Models sometimes escape single quotes, which JSON does not allow.
  for (const text of [json, json.replace(/\\'/g, "'")]) {
    try {
      const value: unknown = JSON.parse(text);
      if (value !== null && typeof value === "object" && !Array.isArray(value))
        return value;
    } catch {
      /* Try the next form. */
    }
  }
  return undefined;
}

function readResponse(response: string) {
  const text = response.trim();
  const start = objectStart(text);
  return {
    text,
    start,
    prefix: start === -1 ? undefined : readJsonPrefix(text, start),
  };
}

/**
 * The JSON object an AI response carries, parsed, or undefined when none
 * parses: the whole response, or its object with fences and prose around it
 * ignored. A code fence inside a JSON string never ends it.
 */
export function readJsonObject(response: string): object | undefined {
  const whole = parseObject(response.trim());
  if (whole) return whole;
  const { text, start, prefix } = readResponse(response);
  // A comma right after the object means a stray brace closed it early.
  if (prefix?.kind !== "complete" || /^\s*,/.test(text.slice(prefix.end)))
    return undefined;
  return parseObject(text.slice(start, prefix.end));
}

/**
 * Whether asking again could help: the response has no JSON object, or its
 * object was cut off. Complete but invalid JSON gets the same answer again,
 * so it is not worth another billed request.
 */
export function isJsonResponseCutOff(response: string): boolean {
  const { prefix } = readResponse(response);
  return prefix === undefined || prefix.kind === "cut";
}

// Helper to parse JSON response from AI
export function parseJsonResponse<T>(response: string): T {
  const value = readJsonObject(response);
  if (value !== undefined) return value as T;

  // Nothing parses as is. Only a cut-off object is repaired, keeping its
  // finished entries; complete but invalid JSON is refused as is.
  try {
    const { prefix } = readResponse(response);
    if (prefix === undefined)
      throw new Error("AI did not return a valid JSON object");
    if (prefix.kind !== "cut" || prefix.repaired === undefined)
      throw new Error("AI returned invalid JSON");
    const repaired = parseObject(prefix.repaired);
    if (!repaired) throw new Error("AI returned invalid JSON");
    return repaired as T;
  } catch (error) {
    console.error("[parseJsonResponse] Failed to parse JSON response");

    // Check if it's a truncation error
    const errorMsg = error instanceof Error ? error.message : "unknown error";
    if (errorMsg.includes("Expected") || errorMsg.includes("Unexpected end")) {
      throw new Error(
        "AI response was truncated (JSON incomplete). Try reducing the complexity of the request.",
        { cause: error },
      );
    }

    throw new Error("Invalid JSON response from AI", { cause: error });
  }
}
