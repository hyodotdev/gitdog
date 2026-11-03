import catalog from "./api-catalog.json" with { type: "json" };
import type { Kind } from "./client.js";

export const API_CATALOG = catalog as ReadonlyArray<{
  path: string;
  kind: Kind;
  args: string;
}>;

export function publicOperation(path: string) {
  const operation = API_CATALOG.find((entry) => entry.path === path);
  if (!operation)
    throw new Error(
      "Unknown public operation. Run gitdog api list. Internal functions cannot be called.",
    );
  return operation;
}
