import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { createTriageServer } from "../server.mjs";

const manualReview = { status: "manual_review", topic: null, draft: null };
const mockDraft = "Спасибо за обращение. Уточним детали заявки.";

async function startServer(context, options) {
  const server = createTriageServer(options);
  await once(server.listen(0, "127.0.0.1"), "listening");
  const triageUrl = `http://127.0.0.1:${server.address().port}/api/triage`;
  context.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));

  return (body) => fetch(triageUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(2_000),
    body,
  });
}

async function assertManualReview(reply, description) {
  assert.equal(reply.status, 200, description);
  assert.deepEqual(await reply.json(), manualReview, description);
}

test("returns a non-empty draft for each valid topic", async (context) => {
  const post = await startServer(context);
  for (const [text, topic] of [
    ["Когда будет доставка?", "delivery"],
    ["Какая цена заказа?", "pricing"],
    ["Можно уточнить детали?", "other"],
  ]) {
    const reply = await post(JSON.stringify({ text }));
    assert.equal(reply.status, 200, topic);
    assert.deepEqual(await reply.json(), { status: "ready", topic, draft: mockDraft }, topic);
  }
});

test("rejects malformed JSON and invalid text with HTTP 400", async (context) => {
  const post = await startServer(context);
  const invalidBodies = [
    "",
    '{"text":',
    ...[
      null, true, 123, "a string", [], ["a string"], {}, { message: "valid text" },
      { text: null }, { text: false }, { text: 123 }, { text: ["valid text"] }, { text: {} },
      { text: "" }, { text: " \n\t " },
    ].map((input) => JSON.stringify(input)),
  ];

  for (const body of invalidBodies) {
    const reply = await post(body);
    const description = `Request body ${JSON.stringify(body)}`;
    assert.equal(reply.status, 400, description);
    assert.deepEqual(await reply.json(), { status: "invalid_input" }, description);
  }
});

test("uses manual review for every failure in the supplied mock", async (context) => {
  const post = await startServer(context);
  for (const marker of ["[timeout]", "[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
    await assertManualReview(await post(JSON.stringify({ text: marker })), marker);
  }
});

test("uses manual review for malformed AI response shapes and field types", async (context) => {
  const post = await startServer(context, { classifyRequest: (output) => output });
  const outputs = [
    null, "delivery", 123, true, [], {},
    { draft: "A draft" }, { topic: "delivery" }, { topic: "refund", draft: "A draft" },
    ...[null, 123, true, ["delivery"], {}].map((topic) => ({ topic, draft: "A draft" })),
    ...[null, 123, true, ["A draft"], {}, "", " \n\t "].map((draft) => ({ topic: "delivery", draft })),
  ];

  for (const output of outputs) {
    const text = JSON.stringify(output);
    await assertManualReview(await post(JSON.stringify({ text })), `Model output ${text}`);
  }
});

for (const outcome of ["success", "error"]) {
  test(`cuts off a model that ignores cancellation at 300 ms before its late ${outcome}`, async (context) => {
    const ready = { topic: "delivery", draft: "A draft" };
    const validOutput = JSON.stringify(ready);
    let announceModelStart;
    const modelStarted = new Promise((resolve) => { announceModelStart = resolve; });
    let settleModel;
    const modelReply = new Promise((resolve, reject) => {
      settleModel = () => {
        if (outcome === "success") resolve(validOutput);
        else reject(new Error("Late provider error"));
      };
    });

    let deadline;
    const post = await startServer(context, {
      classifyRequest(text, { signal }) {
        if (text !== "slow request") return validOutput;
        announceModelStart(signal);
        return modelReply;
      },
      timers: {
        setTimeout(callback, delay) {
          deadline = { callback, delay };
          return deadline;
        },
        clearTimeout(timer) {
          assert.equal(timer, deadline);
          deadline = undefined;
        },
      },
    });
    const pending = post(JSON.stringify({ text: "slow request" }));
    const signal = await Promise.race([
      modelStarted,
      pending.then(() => assert.fail("The API answered before calling the model")),
    ]);
    assert.equal(deadline?.delay, 300);
    assert.equal(signal.aborted, false);
    deadline.callback();

    await assertManualReview(await pending);
    assert.equal(signal.aborted, true);
    assert.equal(deadline, undefined);
    settleModel();

    const next = await post(JSON.stringify({ text: "next request" }));
    assert.equal(next.status, 200);
    assert.deepEqual(await next.json(), { status: "ready", ...ready });
    assert.equal(deadline, undefined);
  });
}
