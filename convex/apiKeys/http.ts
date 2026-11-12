import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { ConvexError } from "convex/values";
import { hashApiKey } from "./security";

const MAX_BODY_BYTES = 65_536;
export const projectApi = httpAction(async (ctx, request) => {
  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  const failure = (status: number, code: string, message: string) =>
    Response.json({ error: { code, message } }, { status, headers });
  const key = request.headers.get("X-Gitdog-Api-Key");
  if (!key || !/^gdk_[a-f0-9]{64}$/.test(key))
    return failure(
      401,
      "UNAUTHORIZED",
      "A valid X-Gitdog-Api-Key header is required.",
    );
  if (
    !request.headers
      .get("Content-Type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    return failure(
      400,
      "BAD_REQUEST",
      "Content-Type must be application/json.",
    );
  const reader = request.body?.getReader();
  if (!reader)
    return failure(400, "BAD_REQUEST", "A JSON request body is required.");
  let text = "";
  let size = 0;
  const decoder = new TextDecoder();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return failure(413, "BAD_REQUEST", "Request body exceeds 64 KiB.");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    const data: unknown = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data))
      return failure(400, "BAD_REQUEST", "Expected a request object.");
    const body = data as Record<string, unknown>;
    if (
      Object.keys(body).some(
        (key) => !["kind", "path", "args"].includes(key),
      ) ||
      typeof body.kind !== "string" ||
      !["query", "mutation"].includes(body.kind) ||
      typeof body.path !== "string" ||
      body.path.length > 120 ||
      !body.args ||
      typeof body.args !== "object" ||
      Array.isArray(body.args)
    )
      return failure(
        400,
        "BAD_REQUEST",
        "Expected kind, path and object args.",
      );
    const value = await ctx.runMutation(internal.apiKeys.gateway.execute, {
      tokenHash: await hashApiKey(key),
      kind: body.kind as "query" | "mutation",
      path: body.path,
      argsJson: JSON.stringify(body.args),
    });
    return Response.json({ value }, { headers });
  } catch (error) {
    if (error instanceof SyntaxError)
      return failure(400, "BAD_REQUEST", "Invalid JSON request body.");
    if (error instanceof ConvexError) {
      let detail: unknown = error.data;
      for (let i = 0; i < 2 && typeof detail === "string"; i++) {
        try {
          detail = JSON.parse(detail);
        } catch {
          break;
        }
      }
      const data =
        detail && typeof detail === "object" && !Array.isArray(detail)
          ? (detail as { code?: unknown; message?: unknown })
          : {};
      const status =
        data.code === "UNAUTHORIZED"
          ? 401
          : data.code === "NOT_FOUND"
            ? 404
            : ["FORBIDDEN", "UNSUPPORTED_OPERATION"].includes(String(data.code))
              ? 403
              : 400;
      if (typeof data.code === "string" && typeof data.message === "string")
        return failure(status, data.code, data.message);
    }
    return failure(
      500,
      "INTERNAL_ERROR",
      "The project API request could not be completed.",
    );
  }
});
