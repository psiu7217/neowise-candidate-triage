import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/);
assert.ok(script, "The page must include its submit handler");

const delivery = { status: "ready", topic: "delivery", draft: "Ответ о доставке." };
const pricing = { status: "ready", topic: "pricing", draft: "Ответ о стоимости." };
const manualReview = { status: "manual_review", topic: null, draft: null };

function createPage() {
  let handleSubmit;
  const requests = [];
  const view = {
    form: { addEventListener(event, handler) { handleSubmit = handler; } },
    "#message": { value: "" },
    "#status": { textContent: "" },
    "#result": { hidden: true },
    "#topic": { textContent: "" },
    "#draft": { textContent: "" },
  };

  runInNewContext(script[1], {
    document: { querySelector: (selector) => view[selector] },
    fetch: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
  });

  return {
    view,
    requests,
    submit(text) {
      view["#message"].value = text;
      return handleSubmit({ preventDefault() {} });
    },
    respond(index, body) {
      requests[index].resolve({ ok: true, json: async () => body });
    },
  };
}

function assertEmptyResult(view) {
  assert.equal(view["#result"].hidden, true);
  assert.equal(view["#topic"].textContent, "");
  assert.equal(view["#draft"].textContent, "");
}

function assertManualReview(view, text) {
  assert.match(view["#status"].textContent, /разберите заявку вручную/i);
  assertEmptyResult(view);
  assert.equal(view["#message"].value, text);
}

test("keeps the latest successful result when an older success arrives late", async () => {
  const { view, submit, respond } = createPage();
  const first = submit("Когда будет доставка?");
  const second = submit("Сколько стоит заказ?");
  respond(1, pricing);
  await second;
  respond(0, delivery);
  await first;

  assert.equal(view["#result"].hidden, false);
  assert.equal(view["#topic"].textContent, "Стоимость");
  assert.equal(view["#draft"].textContent, pricing.draft);
});

const failures = [
  ["manual review response", ({ resolve }) => resolve({ ok: true, json: async () => manualReview })],
  ["network error", ({ reject }) => reject(new Error("Network unavailable"))],
  ["invalid JSON", ({ resolve }) => resolve({
    ok: true,
    async json() { throw new SyntaxError("Invalid JSON"); },
  })],
];

for (const [description, fail] of failures) {
  test(`keeps the latest success when an older request ends with ${description}`, async () => {
    const { view, requests, submit, respond } = createPage();
    const first = submit("Когда будет доставка?");
    const second = submit("Сколько стоит заказ?");

    respond(1, pricing);
    await second;
    fail(requests[0]);
    await first;

    assert.equal(view["#result"].hidden, false);
    assert.equal(view["#topic"].textContent, "Стоимость");
    assert.equal(view["#draft"].textContent, pricing.draft);
    assert.match(view["#status"].textContent, /черновик готов/i);
  });

  test(`keeps the latest ${description} when an older success arrives late`, async () => {
    const { view, requests, submit, respond } = createPage();
    const input = "Сколько стоит заказ?";
    const first = submit("Когда будет доставка?");
    const second = submit(input);

    fail(requests[1]);
    await second;
    respond(0, delivery);
    await first;

    assertManualReview(view, input);
  });
}

test("clears an existing draft while the next request is pending and retains the input after a network error", async () => {
  const { view, requests, submit, respond } = createPage();
  const initial = submit("Когда будет доставка?");
  respond(0, delivery);
  await initial;
  assert.equal(view["#result"].hidden, false);
  assert.equal(view["#draft"].textContent, delivery.draft);

  const input = "Сколько стоит заказ?";
  const next = submit(input);
  assertEmptyResult(view);
  assert.match(view["#status"].textContent, /разбираем заявку/i);

  requests[1].reject(new Error("Network unavailable"));
  await next;
  assertManualReview(view, input);
});
