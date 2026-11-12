/**
 * Attempts to repair truncated JSON by closing open strings, arrays, and objects
 */
function repairTruncatedJson(json: string, callId: string): string {
  let repaired = json;

  // Check if we're inside a string (count unescaped quotes)
  let inString = false;
  for (let i = 0; i < repaired.length; i++) {
    if (repaired[i] === '"' && (i === 0 || repaired[i - 1] !== "\\")) {
      inString = !inString;
    }
  }

  // If we're inside a string, close it
  if (inString) {
    // Truncate any incomplete escape sequence at the end
    if (repaired.endsWith("\\")) {
      repaired = repaired.slice(0, -1);
    }
    repaired += '"';
    console.log(`[repairTruncatedJson:${callId}] Closed open string`);
  }

  // Count open braces and brackets
  let openBraces = 0;
  let openBrackets = 0;
  inString = false;

  for (let i = 0; i < repaired.length; i++) {
    const char = repaired[i];
    if (char === '"' && (i === 0 || repaired[i - 1] !== "\\")) {
      inString = !inString;
    }
    if (!inString) {
      if (char === "{") openBraces++;
      if (char === "}") openBraces--;
      if (char === "[") openBrackets++;
      if (char === "]") openBrackets--;
    }
  }

  // Close any open brackets first, then braces
  for (let i = 0; i < openBrackets; i++) {
    repaired += "]";
  }
  for (let i = 0; i < openBraces; i++) {
    repaired += "}";
  }

  if (openBrackets > 0 || openBraces > 0) {
    console.log(
      `[repairTruncatedJson:${callId}] Closed ${openBrackets} brackets and ${openBraces} braces`,
    );
  }

  return repaired;
}

// Helper to parse JSON response from AI
export function parseJsonResponse<T>(response: string): T {
  // Generate unique call ID for debugging concurrent calls
  const callId = Math.random().toString(36).substring(2, 8);

  console.log(
    `[parseJsonResponse:${callId}] Input type:`,
    typeof response,
    "length:",
    response?.length,
  );

  let cleaned = response.trim();

  try {
    // Only extract from code blocks if the response itself doesn't start with {
    // This prevents extracting bash code blocks from inside a JSON response
    if (!cleaned.startsWith("{")) {
      // Try to extract JSON from code blocks first
      const jsonMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        cleaned = jsonMatch[1].trim();
        console.log(
          `[parseJsonResponse:${callId}] Extracted JSON from code block`,
        );
      }
    } else {
      console.log(
        `[parseJsonResponse:${callId}] Response starts with {, skipping code block extraction`,
      );
    }

    // Remove any leading/trailing non-JSON content
    const jsonStart = cleaned.indexOf("{");
    const jsonEnd = cleaned.lastIndexOf("}");

    console.log(
      `[parseJsonResponse:${callId}] jsonStart:`,
      jsonStart,
      "jsonEnd:",
      jsonEnd,
    );

    if (jsonStart === -1) {
      // No JSON object found at all
      console.error(
        `[parseJsonResponse:${callId}] No JSON object found in response`,
      );
      throw new Error("AI did not return a valid JSON object");
    }

    // If jsonEnd is -1 or before jsonStart, the JSON was truncated
    // Try to repair it by closing open strings and braces
    if (jsonEnd === -1 || jsonStart >= jsonEnd) {
      console.warn(
        `[parseJsonResponse:${callId}] JSON appears truncated, attempting repair...`,
      );
      cleaned = cleaned.substring(jsonStart);
      cleaned = repairTruncatedJson(cleaned, callId);
    } else {
      cleaned = cleaned.substring(jsonStart, jsonEnd + 1);
    }

    // Fix common AI JSON issues:
    // 1. Replace invalid \' with just '
    cleaned = cleaned.replace(/\\'/g, "'");

    // Check for signs of truncated JSON before parsing
    const openBraces = (cleaned.match(/{/g) || []).length;
    const closeBraces = (cleaned.match(/}/g) || []).length;
    const openBrackets = (cleaned.match(/\[/g) || []).length;
    const closeBrackets = (cleaned.match(/]/g) || []).length;

    if (openBraces !== closeBraces || openBrackets !== closeBrackets) {
      console.warn(
        `[parseJsonResponse:${callId}] JSON still unbalanced after repair: { ${openBraces}/${closeBraces}, [ ${openBrackets}/${closeBrackets}`,
      );
      // Try repair again
      cleaned = repairTruncatedJson(cleaned, callId);
    }

    // Try parsing
    return JSON.parse(cleaned) as T;
  } catch (error) {
    console.error(
      `[parseJsonResponse:${callId}] Failed to parse JSON response`,
    );
    console.error(`[parseJsonResponse:${callId}] Parse error`);

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
