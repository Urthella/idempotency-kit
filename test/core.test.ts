import assert from "node:assert/strict";
import { test } from "node:test";

import { type Incoming, type Outcome, begin, parseKey } from "../src/core.ts";
import { memoryStore } from "../src/stores.ts";

test("keys are Structured Field Strings, and bare values are accepted too", () => {
  assert.equal(parseKey('"8e03978e-40d5-43e8-bc93-6894a57f9324"'), "8e03978e-40d5-43e8-bc93-6894a57f9324");
  assert.equal(parseKey('"a \\"quoted\\" \\\\ key"'), 'a "quoted" \\ key');
  assert.equal(parseKey("8e03978e-40d5-43e8-bc93-6894a57f9324"), "8e03978e-40d5-43e8-bc93-6894a57f9324");
  assert.equal(parseKey('  "padded"  '), "padded");
  assert.equal(parseKey("x".repeat(255)), "x".repeat(255));
  for (const bad of ['""', "", '"unclosed', 'un"quoted', '"bad \\n escape"', '"tab\there"', '"é"', "has space", "x".repeat(256)]) {
    assert.equal(parseKey(bad), undefined, bad);
  }
});

const request = (overrides: Partial<Incoming> = {}): Incoming => ({
  method: "POST",
  path: "/orders",
  header: '"k1"',
  body: Buffer.from('{"item":1}'),
  scope: "",
  ...overrides,
});

const status = (outcome: Outcome) => (outcome.kind === "respond" ? outcome.response.status : outcome.kind);
const problem = (outcome: Outcome) =>
  outcome.kind === "respond" ? JSON.parse(Buffer.from(outcome.response.body, "base64").toString()) : undefined;

test("other methods, and requests without a key, pass through unless a key is required", async () => {
  const options = { store: memoryStore() };
  assert.equal(status(await begin(options, request({ method: "GET" }))), "pass");
  assert.equal(status(await begin(options, request({ method: "PUT" }))), "pass");
  assert.equal(status(await begin(options, request({ header: null }))), "pass");
  const missing = await begin({ ...options, required: true }, request({ header: null }));
  assert.equal(status(missing), 400);
  assert.equal(problem(missing).title, "Idempotency-Key is missing");
  assert.equal(status(await begin(options, request({ header: '"' }))), 400);
  assert.equal(status(await begin({ ...options, methods: ["PUT"] }, request({ method: "put" }))), "run");
});

test("the protocol: run once, 409 while running, replay after, 422 for a different request", async () => {
  const options = { store: memoryStore() };
  const first = await begin(options, request());
  assert.equal(first.kind, "run");

  const during = await begin(options, request());
  assert.equal(status(during), 409);
  assert.deepEqual(during.kind === "respond" && during.response.headers, [
    ["content-type", "application/problem+json"],
    ["retry-after", "1"],
  ]);

  if (first.kind === "run") await first.finish({ status: 201, headers: [["x-order", "7"]], body: "b2s=" });
  const again = await begin(options, request());
  assert.deepEqual(again, { kind: "respond", replayed: true, response: { status: 201, headers: [["x-order", "7"]], body: "b2s=" } });

  for (const other of [request({ body: Buffer.from('{"item":2}') }), request({ path: "/refunds" }), request({ method: "PATCH" })]) {
    const reused = await begin(options, other);
    assert.equal(status(reused), 422);
    assert.equal(problem(reused).title, "Idempotency-Key is already used");
  }
});

test("a server error frees the key, so a retry runs", async () => {
  const options = { store: memoryStore() };
  const first = await begin(options, request());
  if (first.kind === "run") await first.finish({ status: 503, headers: [], body: "" });
  assert.equal((await begin(options, request())).kind, "run");
});

test("a client error is an answer, and is replayed", async () => {
  const options = { store: memoryStore() };
  const first = await begin(options, request());
  if (first.kind === "run") await first.finish({ status: 404, headers: [], body: "" });
  assert.equal(status(await begin(options, request())), 404);
});

test("scopes keep the same key apart", async () => {
  const options = { store: memoryStore() };
  assert.equal((await begin(options, request({ scope: "alice" }))).kind, "run");
  assert.equal((await begin(options, request({ scope: "bob", body: Buffer.from("other") }))).kind, "run");
});

test("errors link to the documentation you give", async () => {
  const reply = await begin({ store: memoryStore(), required: true, docs: "https://example.com/idem" }, request({ header: null }));
  assert.equal(problem(reply).type, "https://example.com/idem");
  assert.equal(problem(reply).status, 400);
});
