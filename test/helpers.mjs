import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { Ui } from "../dist/ui.js";
import { BOOLEAN_SETTINGS } from "../dist/projects.js";

export const settings = Object.fromEntries(
  BOOLEAN_SETTINGS.map((key) => [key, true]),
);
export const repository = {
  _id: "test-repository-id",
  githubRepo: "owner/repo",
  settings,
  isActive: true,
};

export class CaptureUi extends Ui {
  values = [];
  messages = [];
  confirmations = [];
  constructor() {
    super(true);
  }
  output(value) {
    this.values.push(structuredClone(value));
  }
  info(value) {
    this.messages.push(value);
  }
  async confirm(message, yes = false) {
    this.confirmations.push(message);
    if (!yes) throw new Error("Confirmation required.");
  }
}

export async function fixture(t) {
  const root = process.env.GITDOG_TEST_DIR || tmpdir();
  await mkdir(root, { recursive: true });
  const path = await mkdtemp(join(root, "gitdog-test-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

export async function mockServer(t, handler) {
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      const call = {
        path: body.path,
        args: body.args[0],
        authorization: request.headers.authorization,
        route: request.url,
      };
      requests.push(call);
      const value = await handler(call);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ status: "success", value, logLines: [] }));
    } catch (error) {
      response.writeHead(560, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          status: "error",
          errorMessage: error.message,
          logLines: [],
        }),
      );
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

export function jwt(expires = Date.now() / 1000 + 3600) {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ exp: expires })).toString("base64url")}.fake-signature`;
}
