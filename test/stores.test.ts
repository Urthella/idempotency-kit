import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

import { createClient } from "redis";

import type { Done, Processing, Store } from "../src/core.ts";
import { memoryStore, redisStore } from "../src/stores.ts";

const processing = (token: string): Processing => ({ state: "processing", fingerprint: "f", token });
const done: Done = { state: "done", fingerprint: "f", response: { status: 201, headers: [], body: "" } };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** What every store has to do. `wait` lets time pass, really or on a fake clock. */
function contract(name: string, make: () => Store, wait: (ms: number) => Promise<void>) {
  describe(name, () => {
    test("a free key is claimed once", async () => {
      const store = make();
      assert.equal(await store.claim("k", processing("a"), 10_000), undefined);
      assert.deepEqual(await store.claim("k", processing("b"), 10_000), processing("a"));
    });

    test("only the request holding the key can complete or release it", async () => {
      const store = make();
      await store.claim("k", processing("a"), 10_000);
      assert.equal(await store.complete("k", "b", done, 10_000), false);
      await store.release("k", "b");
      assert.deepEqual(await store.claim("k", processing("c"), 10_000), processing("a"));
      assert.equal(await store.complete("k", "a", done, 10_000), true);
      assert.deepEqual(await store.claim("k", processing("c"), 10_000), done);
      // A done record isn't released by its old token either.
      await store.release("k", "a");
      assert.deepEqual(await store.claim("k", processing("c"), 10_000), done);
    });

    test("a released key can be claimed again", async () => {
      const store = make();
      await store.claim("k", processing("a"), 10_000);
      await store.release("k", "a");
      assert.equal(await store.claim("k", processing("b"), 10_000), undefined);
    });

    test("a lock that runs out lets another request in, and the first can't complete", async () => {
      const store = make();
      await store.claim("k", processing("a"), 50);
      await wait(120);
      assert.equal(await store.claim("k", processing("b"), 10_000), undefined);
      assert.equal(await store.complete("k", "a", done, 10_000), false);
      assert.equal(await store.complete("k", "b", done, 10_000), true);
    });

    test("a saved response expires after its time to live", async () => {
      const store = make();
      await store.claim("k", processing("a"), 10_000);
      await store.complete("k", "a", done, 50);
      await wait(120);
      assert.equal(await store.claim("k", processing("b"), 10_000), undefined);
    });
  });
}

let clock = 0;
contract(
  "memory store",
  () => memoryStore(() => clock),
  async (ms) => {
    clock += ms;
  },
);

// The Redis store is checked against a real server when REDIS_URL is set, as it is in CI.
if (process.env.REDIS_URL) {
  const client = createClient({ url: process.env.REDIS_URL });
  await client.connect();
  after(() => client.close());
  let run = 0;
  contract(
    "redis store",
    () => redisStore(client, `test:${process.pid}:${run++}:`),
    sleep,
  );
} else {
  test("redis store", { skip: "set REDIS_URL to run it against a real server" }, () => {});
}
