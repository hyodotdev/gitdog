import { GENERATION_MODELS } from "../_ai/config";
import type { KeyProvider } from "./crypto";

const VALIDATION_TIMEOUT_MS = 10_000;

export type KeyValidationResult =
  | { ok: true }
  | {
      ok: false;
      code: "invalid" | "no_model_access" | "unavailable";
      httpStatus?: number;
    };

// Checks the exact generation model so a saved key is known to be usable.
// Provider response bodies are never read or surfaced.
export async function validateProviderKey(
  provider: KeyProvider,
  apiKey: string,
): Promise<KeyValidationResult> {
  const request: { url: string; headers: Record<string, string> } =
    provider === "anthropic"
      ? {
          url: `https://api.anthropic.com/v1/models/${GENERATION_MODELS.anthropic.modelId}`,
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
        }
      : {
          url: `https://api.openai.com/v1/models/${GENERATION_MODELS.openai.modelId}`,
          headers: { Authorization: `Bearer ${apiKey}` },
        };
  let response: Response;
  try {
    response = await fetch(request.url, {
      method: "GET",
      headers: request.headers,
      signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, code: "unavailable" };
  }
  await response.body?.cancel().catch(() => undefined);
  switch (true) {
    case response.ok:
      return { ok: true };
    case response.status === 401 || response.status === 403:
      return { ok: false, code: "invalid", httpStatus: response.status };
    case response.status === 404:
      return { ok: false, code: "no_model_access", httpStatus: 404 };
    default:
      return { ok: false, code: "unavailable", httpStatus: response.status };
  }
}
