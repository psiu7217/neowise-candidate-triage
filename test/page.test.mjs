import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

test("the latest response wins and a new failure clears the draft", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  assert.ok(script, "The page must include its submit handler");

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
    fetch: () => new Promise((resolve) => requests.push(resolve)),
  });

  function submit(text) {
    view["#message"].value = text;
    return handleSubmit({ preventDefault() {} });
  }

  function respond(index, body) {
    requests[index]({ ok: true, json: async () => body });
  }

  const first = submit("Когда будет доставка?");
  const second = submit("Сколько стоит заказ?");
  respond(1, { status: "ready", topic: "pricing", draft: "Ответ о стоимости." });
  await second;
  respond(0, { status: "ready", topic: "delivery", draft: "Ответ о доставке." });
  await first;

  assert.equal(view["#result"].hidden, false);
  assert.equal(view["#topic"].textContent, "Стоимость");
  assert.equal(view["#draft"].textContent, "Ответ о стоимости.");

  const failed = submit("[empty-draft]");
  respond(2, { status: "manual_review", topic: null, draft: null });
  await failed;

  assert.match(view["#status"].textContent, /разберите заявку вручную/i);
  assert.equal(view["#result"].hidden, true);
  assert.equal(view["#topic"].textContent, "");
  assert.equal(view["#draft"].textContent, "");
  assert.equal(view["#message"].value, "[empty-draft]");
});
