#!/usr/bin/env node
import { CommanderError } from "commander";
import { createProgram, normalizeArgv } from "./commands.js";
import { clean } from "./ui.js";

const argv = normalizeArgv(process.argv.slice(2));
const json = argv.includes("--json");
const program = createProgram();
program.exitOverride();
program.configureOutput({
  writeErr: (value) => {
    process.stderr.write(clean(value));
  },
});
if (json)
  program.configureOutput({ writeErr: () => {}, outputError: () => {} });
try {
  await program.parseAsync(argv, { from: "user" });
} catch (error) {
  if (error instanceof CommanderError && error.exitCode === 0)
    process.exitCode = 0;
  else {
    const raw = error instanceof Error ? error.message : "Unexpected error.";
    const message = clean(raw);
    if (json)
      process.stderr.write(`${JSON.stringify({ error: { message } })}\n`);
    else if (!(error instanceof CommanderError))
      process.stderr.write(`\nError: ${message}\n`);
    process.exitCode = error instanceof CommanderError ? error.exitCode : 1;
  }
}
