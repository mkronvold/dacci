#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distRoot = path.resolve(__dirname, "dist");
const indexPath = path.join(distRoot, "index.html");
const host = process.env.HOST ?? "0.0.0.0";
const port = parsePort(process.env.PORT ?? "4173", 4173);
const apiBaseUrl =
  process.env.WEB_API_BASE_URL?.trim() ||
  process.env.VITE_API_BASE_URL?.trim() ||
  "http://localhost:3000";

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const pathname = decodeURIComponent(requestUrl.pathname);

  if (pathname === "/health" || pathname === "/ready") {
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(
      JSON.stringify({
        status: "ok",
        service: "dacci-web",
        apiBaseUrl,
      }),
    );
    return;
  }

  if (pathname === "/runtime-config.json") {
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    });
    response.end(JSON.stringify({ apiBaseUrl }));
    return;
  }

  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const candidatePath = path.resolve(distRoot, relativePath);
  const safePath = candidatePath.startsWith(distRoot) ? candidatePath : indexPath;
  const assetPath = (await fileExists(safePath)) ? safePath : indexPath;

  response.writeHead(200, {
    "Content-Type": getContentType(assetPath),
  });

  createReadStream(assetPath).pipe(response);
});

server.listen(port, host, () => {
  process.stdout.write(
    `Dacci Web listening on http://${host}:${port} with API base ${apiBaseUrl}\n`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close((error) => {
      if (error) {
        process.stderr.write(`Failed to stop web server cleanly: ${error.message}\n`);
        process.exitCode = 1;
      }

      process.exit();
    });
  });
}

function parsePort(value, fallback) {
  const parsedValue = Number.parseInt(value, 10);
  return Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : fallback;
}

async function fileExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function getContentType(targetPath) {
  switch (path.extname(targetPath).toLowerCase()) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}
