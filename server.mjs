import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { classify } from "./mock-ai.mjs";

const html = await readFile(new URL("./index.html", import.meta.url));
const AI_TIMEOUT_MS = 300;
const allowedTopics = new Set(["delivery", "pricing", "other"]);
const invalidInput = { status: "invalid_input" };
const manualReview = { status: "manual_review", topic: null, draft: null };

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function classifyWithinDeadline(text) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("AI timeout"));
    }, AI_TIMEOUT_MS);
  });

  try {
    return await Promise.race([classify(text, { signal: controller.signal }), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function handleTriage(request, response) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);

  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return json(response, 400, invalidInput);
  }

  const text = input?.text;
  if (typeof text !== "string" || !text.trim()) {
    return json(response, 400, invalidInput);
  }

  let result;
  try {
    result = JSON.parse(await classifyWithinDeadline(text));
  } catch {
    return json(response, 200, manualReview);
  }

  const topic = result?.topic;
  const draft = typeof result?.draft === "string" ? result.draft.trim() : "";
  if (!allowedTopics.has(topic) || !draft) {
    return json(response, 200, manualReview);
  }

  return json(response, 200, { status: "ready", topic, draft });
}

export function createTriageServer() {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }
    try {
      await handleTriage(request, response);
    } catch {
      json(response, 500, { status: "server_error" });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createTriageServer().listen(Number(process.env.PORT || 3000), "127.0.0.1");
}
