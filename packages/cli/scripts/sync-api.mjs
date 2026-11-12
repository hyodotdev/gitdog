import ts from "typescript";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const backend = resolve(
  process.argv.find((arg) => arg.startsWith("--backend="))?.slice(10) ??
    resolve(dirname(fileURLToPath(import.meta.url)), "../../../convex"),
);
const entries = [];
async function visit(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, item.name);
    if (item.name.startsWith("_") || item.name === "node_modules") continue;
    if (item.isDirectory()) {
      await visit(path);
      continue;
    }
    if (!item.name.endsWith(".ts") || item.name.endsWith(".d.ts")) continue;
    const source = ts.createSourceFile(
      path,
      await readFile(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const node of source.statements) {
      if (
        !ts.isVariableStatement(node) ||
        !node.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
        )
      )
        continue;
      for (const declaration of node.declarationList.declarations) {
        const call = declaration.initializer;
        if (
          !ts.isIdentifier(declaration.name) ||
          !call ||
          !ts.isCallExpression(call) ||
          !ts.isIdentifier(call.expression)
        )
          continue;
        const kind = call.expression.text;
        if (!["query", "mutation", "action"].includes(kind)) continue;
        const object = call.arguments[0];
        if (!object || !ts.isObjectLiteralExpression(object))
          throw new Error(`Unsupported public definition in ${path}`);
        const args = object.properties.find(
          (property) => property.name?.getText(source) === "args",
        );
        const definitions = Object.fromEntries(
          source.statements
            .filter(ts.isVariableStatement)
            .flatMap((item) =>
              item.declarationList.declarations
                .filter(
                  (entry) => ts.isIdentifier(entry.name) && entry.initializer,
                )
                .map((entry) => [
                  entry.name.text,
                  entry.initializer.getText(source),
                ]),
            ),
        );
        let validator =
          args && ts.isPropertyAssignment(args)
            ? args.initializer.getText(source)
            : "{}";
        for (const [name, value] of Object.entries(definitions)) {
          if (name.endsWith("Validator"))
            validator = validator.replaceAll(
              new RegExp(`\\b${name}\\b`, "g"),
              value,
            );
        }
        entries.push({
          path: `${relative(backend, path).replaceAll("\\", "/").slice(0, -3)}:${declaration.name.text}`,
          kind,
          args: validator,
        });
      }
    }
  }
}
await visit(backend);
entries.sort((left, right) => left.path.localeCompare(right.path));
const content = JSON.stringify(entries, null, 2) + "\n";
const target = new URL("../src/api-catalog.json", import.meta.url);
if (process.argv.includes("--check")) {
  if (
    JSON.stringify(JSON.parse(await readFile(target, "utf8"))) !==
    JSON.stringify(entries)
  )
    throw new Error(
      "Public API catalog is stale. Run bun scripts/sync-api.mjs.",
    );
  console.log(
    `Public API catalog matches all ${entries.length} exported functions.`,
  );
} else {
  await writeFile(target, content);
  console.log(
    `Recorded ${entries.length} public functions. Internal functions are excluded.`,
  );
}
