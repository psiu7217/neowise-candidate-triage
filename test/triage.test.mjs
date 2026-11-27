import assert from "node:assert/strict";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { after, before, test } from "node:test";
import { createTriageServer } from "../server.mjs";

const server = createTriageServer();
const manualReview = { status: "manual_review", topic: null, draft: null };
let triageUrl;

before(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  triageUrl = `http://127.0.0.1:${server.address().port}/api/triage`;
});

after(() => new Promise((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve());
}));

function post(body) {
  return fetch(triageUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

test("returns a topic and a non-empty draft for a valid request", async () => {
  const reply = await post(JSON.stringify({ text: "Когда будет доставка?" }));

  assert.equal(reply.status, 200);
  assert.deepEqual(await reply.json(), {
    status: "ready",
    topic: "delivery",
    draft: "Спасибо за обращение. Уточним детали заявки.",
  });
});

test("rejects malformed JSON and invalid text with HTTP 400", async () => {
  const invalidBodies = [
    '{"text":',
    "null",
    "{}",
    JSON.stringify({ text: 123 }),
    JSON.stringify({ text: "" }),
    JSON.stringify({ text: " \n\t " }),
  ];

  for (const body of invalidBodies) {
    const reply = await post(body);
    assert.equal(reply.status, 400, body);
    assert.deepEqual(await reply.json(), { status: "invalid_input" }, body);
  }
});

test("uses manual review for exceptions and unusable AI responses", async () => {
  for (const marker of ["[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
    const reply = await post(JSON.stringify({ text: marker }));
    assert.equal(reply.status, 200, marker);
    assert.deepEqual(await reply.json(), manualReview, marker);
  }
});

test("returns manual review before the slow mock finishes", async () => {
  const start = performance.now();
  const reply = await post(JSON.stringify({ text: "[timeout]" }));
  const body = await reply.json();
  const elapsed = performance.now() - start;

  assert.equal(reply.status, 200);
  assert.deepEqual(body, manualReview);
  // Leave room for local scheduling and HTTP overhead, but fail if we wait for the 1200 ms mock.
  assert.ok(elapsed < 1000, `Slow mock was not cut off in time: ${elapsed.toFixed(0)} ms`);
});
