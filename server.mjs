import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { BrowserLookup } from "./browser-lookup.mjs";
import { WorkspaceStore } from "./workspace-store.mjs";
import { LocalAI } from "./local-ai.mjs";
import { normalizeCnr } from "./case-details.mjs";

const staticFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/case-details.mjs", ["case-details.mjs", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/workspace.html", ["workspace.html", "text/html; charset=utf-8"]],
  ["/workspace.js", ["workspace.js", "text/javascript; charset=utf-8"]],
  ["/workspace.css", ["workspace.css", "text/css; charset=utf-8"]]
]);

function json(response, status, data) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(data));
}

async function readJson(request, limit = 2048) {
  let text = "";
  let bytes = 0;
  const decoder = new StringDecoder("utf8");
  for await (const chunk of request) {
    text += decoder.write(chunk);
    bytes += chunk.length;
    if (bytes > limit) throw new Error("Request is too large.");
  }
  text += decoder.end();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Send a valid JSON request.");
  }
}

export function createAppServer(lookup = new BrowserLookup(), { store = new WorkspaceStore(), ai = new LocalAI() } = {}) {
  return http.createServer(async (request, response) => {
    const expectedHost = `localhost:${request.socket.localPort}`;
    if (![expectedHost, `127.0.0.1:${request.socket.localPort}`].includes(request.headers.host)) {
      return json(response, 403, { error: "Only local requests are allowed." });
    }
    const base = `http://${request.headers.host}`;
    if (request.headers.origin && request.headers.origin !== base) {
      return json(response, 403, { error: "Cross-origin requests are not allowed." });
    }
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    const url = new URL(request.url, base);
    try {
      if (url.pathname.startsWith("/api/") && ["POST", "PUT"].includes(request.method)
        && !request.headers["content-type"]?.startsWith("application/json")) {
        return json(response, 415, { error: "Use application/json." });
      }
      if (request.method === "GET" && url.pathname === "/api/ai/status") {
        return json(response, 200, await ai.status());
      }
      const workspace = url.pathname.match(/^\/api\/cases\/([^/]+)(?:\/(snapshot|documents|assist)(?:\/([a-f0-9-]+)(\/download)?)?)?$/);
      if (workspace) {
        const [, rawCnr, resource, id, download] = workspace;
        const cnr = normalizeCnr(rawCnr);
        if (!resource && request.method === "GET") return json(response, 200, await store.workspace(cnr));
        if (resource === "snapshot" && request.method === "PUT") {
          await store.saveSnapshot(cnr, await readJson(request, 8 * 1024 * 1024));
          return json(response, 200, { saved: true });
        }
        if (resource === "documents" && !id && request.method === "POST") {
          return json(response, 201, await store.upload(cnr, await readJson(request, 15 * 1024 * 1024)));
        }
        if (resource === "documents" && id && request.method === "GET") {
          const document = await store.document(cnr, id);
          if (download) {
            response.writeHead(200, {
              "Content-Type": "application/octet-stream",
              "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(document.name).replaceAll("'", "%27")}`,
              "Cache-Control": "no-store"
            });
            return response.end(Buffer.from(document.content, "base64"));
          }
          const { content, ...result } = document;
          return json(response, 200, result);
        }
        if (resource === "documents" && id && !download && request.method === "DELETE") {
          await store.deleteDocument(cnr, id);
          return json(response, 200, { deleted: true });
        }
        if (resource === "assist" && request.method === "POST") {
          const input = await readJson(request, 24000);
          if (!input || typeof input !== "object") throw new Error("Provide a question and task.");
          const [documents, saved] = await Promise.all([store.documents(cnr), store.workspace(cnr)]);
          return json(response, 200, await ai.answer({ ...input, documents, snapshot: saved.snapshot }));
        }
      }
      if (request.method === "GET" && url.pathname === "/api/health") {
        const active = lookup.session;
        return json(response, 200, { ready: true, lookup: active ? { id: active.id, cnr: active.cnr, expiresAt: active.expiresAt } : null });
      }
      if (request.method === "POST" && url.pathname === "/api/lookup") {
        if (!request.headers["content-type"]?.startsWith("application/json")) {
          return json(response, 415, { error: "Use application/json." });
        }
        const body = await readJson(request);
        return json(response, 200, await lookup.start(body?.cnr));
      }
      const match = url.pathname.match(/^\/api\/lookup\/([a-f0-9-]+)(\/import)?$/);
      if (match && request.method === "POST" && match[2]) {
        if (!request.headers["content-type"]?.startsWith("application/json")) {
          return json(response, 415, { error: "Use application/json." });
        }
        return json(response, 200, { record: await lookup.import(match[1]) });
      }
      if (match && request.method === "DELETE" && !match[2]) {
        // Closing an already closed browser is safe and lets the UI recover from expiration.
        if (lookup.session) await lookup.close(match[1]);
        return json(response, 200, { closed: true });
      }
      const asset = staticFiles.get(url.pathname);
      if (request.method === "GET" && asset) {
        const content = await readFile(new URL(asset[0], import.meta.url));
        response.writeHead(200, { "Content-Type": asset[1], "Cache-Control": "no-store" });
        return response.end(content);
      }
      return json(response, 404, { error: "Not found." });
    } catch (error) {
      console.error("Case lookup request failed:", error.message);
      return json(response, 400, { error: error.message });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const lookup = new BrowserLookup();
  const server = createAppServer(lookup);
  const port = Number(process.env.PORT || 8000);
  server.on("error", (error) => {
    console.error(`Could not start case tracker on port ${port}: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => console.log(`Case tracker: http://localhost:${port}`));
  const shutdown = async () => {
    server.close();
    try {
      await lookup.close();
    } catch (error) {
      console.error("Could not close lookup browser:", error.message);
      process.exitCode = 1;
    }
    server.closeAllConnections();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
