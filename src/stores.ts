import type { Done, Processing, Store, StoredRecord } from "./core.ts";

/**
 * Keeps records in this process. For tests and single-process servers: a restart forgets every
 * key, and separate processes don't see each other's.
 */
// ponytail: expired records are dropped only when their key is used again; sweep them if keys never repeat.
export function memoryStore(now: () => number = Date.now): Store {
  const records = new Map<string, { record: StoredRecord; expires: number }>();
  const live = (key: string) => {
    const entry = records.get(key);
    if (entry && entry.expires <= now()) records.delete(key);
    return records.get(key);
  };
  const holds = (key: string, token: string) => {
    const record = live(key)?.record;
    return record?.state === "processing" && record.token === token;
  };
  return {
    async claim(key, record: Processing, lockMs) {
      const existing = live(key);
      if (existing) return existing.record;
      records.set(key, { record, expires: now() + lockMs });
      return undefined;
    },
    async complete(key, token, record: Done, ttlMs) {
      if (!holds(key, token)) return false;
      records.set(key, { record, expires: now() + ttlMs });
      return true;
    },
    async release(key, token) {
      if (holds(key, token)) records.delete(key);
    },
  };
}

/** The one call the Redis store needs. node-redis clients have it; wrap others, like ioredis's `call`. */
export interface RedisLike {
  sendCommand(args: string[]): Promise<unknown>;
}

// Replace or delete a record only while the request that claimed it still holds it.
const COMPLETE = `local r = redis.call("GET", KEYS[1])
if r and cjson.decode(r).token == ARGV[1] then
  redis.call("SET", KEYS[1], ARGV[2], "PX", ARGV[3])
  return 1
end
return 0`;
const RELEASE = `local r = redis.call("GET", KEYS[1])
if r and cjson.decode(r).token == ARGV[1] then return redis.call("DEL", KEYS[1]) end
return 0`;

/** Keeps records in Redis, so every process behind a load balancer sees the same keys. */
export function redisStore(client: RedisLike, prefix = "idempotency:"): Store {
  return {
    async claim(key, record, lockMs) {
      for (;;) {
        const set = await client.sendCommand(["SET", prefix + key, JSON.stringify(record), "NX", "PX", String(lockMs)]);
        if (set === "OK") return undefined;
        const existing = await client.sendCommand(["GET", prefix + key]);
        // If it expired between the two calls, try to claim it again.
        if (typeof existing === "string") return JSON.parse(existing) as StoredRecord;
      }
    },
    async complete(key, token, record, ttlMs) {
      const args = ["EVAL", COMPLETE, "1", prefix + key, token, JSON.stringify(record), String(ttlMs)];
      return (await client.sendCommand(args)) === 1;
    },
    async release(key, token) {
      await client.sendCommand(["EVAL", RELEASE, "1", prefix + key, token]);
    },
  };
}
