// Real requests through Express (over HTTP) and Hono (through app.request), with the same checks.

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, describe, test } from "node:test";

import express from "express";
import { Hono } from "hono";

import { idempotency as expressIdempotency } from "../src/express.ts";
import { idempotency as honoIdempotency } from "../src/hono.ts";
import { memoryStore } from "../src/stores.ts";

type Send = (path: string, init?: RequestInit) => Promise<Response>;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface App {
  send: Send;
  /** How many times each handler ran. */
  runs: Map<string, number>;
}

async function expressApp(): Promise<App> {
  const runs = new Map<string, number>();
  const ran = (name: string) => runs.set(name, (runs.get(name) ?? 0) + 1);
  const app = express();
  app.set("env", "test"); // no stack traces in the output for the failing handler
  app.use(express.json());
  app.use(expressIdempotency({ store: memoryStore(), scope: (req) => req.get("x-user") ?? "" }));
  app.post("/orders", async (req, res) => {
    ran("orders");
    await sleep(50);
    res.status(201).set("x-order", "7").json({ id: 7, item: req.body.item });
  });
  app.post("/chunks", (_req, res) => {
    ran("chunks");
    res.write("one,");
    res.write(Buffer.from("two,"));
    res.end("three");
  });
  app.post("/fails", () => {
    ran("fails");
    throw new Error("boom");
  });
  app.get("/orders", (_req, res) => {
    ran("list");
    res.json([]);
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { send: (path, init) => fetch(base + path, init), runs };
}

async function honoApp(): Promise<App> {
  const runs = new Map<string, number>();
  const ran = (name: string) => runs.set(name, (runs.get(name) ?? 0) + 1);
  const app = new Hono();
  app.onError((_e, c) => c.text("failed", 500));
  app.use(honoIdempotency({ store: memoryStore(), scope: (c) => c.req.header("x-user") ?? "" }));
  app.post("/orders", async (c) => {
    ran("orders");
    await sleep(50);
    const { item } = await c.req.json();
    return c.json({ id: 7, item }, 201, { "x-order": "7" });
  });
  app.post("/chunks", (c) => {
    ran("chunks");
    return c.text("one,two,three");
  });
  app.post("/fails", () => {
    ran("fails");
    throw new Error("boom");
  });
  app.get("/orders", (c) => {
    ran("list");
    return c.json([]);
  });
  return { send: async (path, init) => app.request(path, init), runs };
}

const post = (key: string | null, body: unknown = { item: 1 }, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", ...(key === null ? {} : { "idempotency-key": key }), ...headers },
  body: JSON.stringify(body),
});

for (const [name, make] of [
  ["express", expressApp],
  ["hono", honoApp],
] as const) {
  describe(name, () => {
    test("a retry gets the first response back without running the handler again", async () => {
      const { send, runs } = await make();
      const first = await send("/orders", post('"k1"'));
      const firstBody = await first.text();
      const again = await send("/orders", post('"k1"'));
      assert.equal(first.status, 201);
      assert.equal(again.status, 201);
      assert.equal(await again.text(), firstBody);
      assert.equal(again.headers.get("x-order"), "7");
      assert.equal(again.headers.get("idempotent-replayed"), "true");
      assert.equal(first.headers.get("idempotent-replayed"), null);
      assert.equal(runs.get("orders"), 1);
    });

    test("twenty requests at once with one key run the handler once", async () => {
      const { send, runs } = await make();
      const replies = await Promise.all(Array.from({ length: 20 }, () => send("/orders", post('"k2"'))));
      const statuses = replies.map((r) => r.status).sort();
      assert.equal(runs.get("orders"), 1);
      assert.equal(statuses.filter((s) => s === 201).length, 1, `${statuses}`);
      assert.equal(statuses.filter((s) => s === 409).length, 19);
      const conflict = replies.find((r) => r.status === 409)!;
      assert.equal(conflict.headers.get("content-type"), "application/problem+json");
      assert.equal(conflict.headers.get("retry-after"), "1");
    });

    test("the same key with a different body gets 422", async () => {
      const { send, runs } = await make();
      await send("/orders", post('"k3"', { item: 1 }));
      const reused = await send("/orders", post('"k3"', { item: 2 }));
      assert.equal(reused.status, 422);
      assert.equal(((await reused.json()) as { title: string }).title, "Idempotency-Key is already used");
      assert.equal(runs.get("orders"), 1);
    });

    test("a handler that fails can be retried", async () => {
      const { send, runs } = await make();
      assert.equal((await send("/fails", post('"k4"'))).status, 500);
      assert.equal((await send("/fails", post('"k4"'))).status, 500);
      assert.equal(runs.get("fails"), 2);
    });

    test("a body written in pieces is replayed whole", async () => {
      const { send, runs } = await make();
      assert.equal(await (await send("/chunks", post('"k5"'))).text(), "one,two,three");
      assert.equal(await (await send("/chunks", post('"k5"'))).text(), "one,two,three");
      assert.equal(runs.get("chunks"), 1);
    });

    test("GET and requests without a key run as usual", async () => {
      const { send, runs } = await make();
      await send("/orders");
      await send("/orders");
      await send("/orders", post(null));
      await send("/orders", post(null));
      assert.equal(runs.get("list"), 2);
      assert.equal(runs.get("orders"), 2);
    });

    test("an invalid key gets 400", async () => {
      const { send, runs } = await make();
      const reply = await send("/orders", post('"unclosed'));
      assert.equal(reply.status, 400);
      assert.equal(runs.get("orders"), undefined);
    });

    test("scopes keep two users' keys apart", async () => {
      const { send, runs } = await make();
      await send("/orders", post('"k6"', { item: 1 }, { "x-user": "alice" }));
      const bob = await send("/orders", post('"k6"', { item: 2 }, { "x-user": "bob" }));
      assert.equal(bob.status, 201);
      assert.equal(runs.get("orders"), 2);
    });
  });
}

test("express: a client that hangs up mid-request still gets the saved response on retry", async () => {
  const { send, runs } = await expressApp();
  const abort = new AbortController();
  const hangUp = send("/orders", { ...post('"k8"'), signal: abort.signal });
  // The handler takes 50 ms, so it's halfway through when the client goes.
  await sleep(20);
  abort.abort();
  await assert.rejects(hangUp);
  // The handler is still running, so a retry has to wait.
  assert.equal((await send("/orders", post('"k8"'))).status, 409);
  await sleep(100);
  const retry = await send("/orders", post('"k8"'));
  assert.equal(retry.status, 201);
  assert.equal(retry.headers.get("idempotent-replayed"), "true");
  assert.equal(runs.get("orders"), 1);
});
