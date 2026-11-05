// The protocol from the IETF Idempotency-Key draft (draft-ietf-httpapi-idempotency-key-header-08),
// independent of any framework. The adapters in express.ts and hono.ts call `begin`.

import { createHash, randomUUID } from "node:crypto";

export interface StoredResponse {
  status: number;
  headers: [string, string][];
  /** base64 */
  body: string;
}

export type Processing = { state: "processing"; fingerprint: string; token: string };
export type Done = { state: "done"; fingerprint: string; response: StoredResponse };
export type StoredRecord = Processing | Done;

export interface Store {
  /** Claims a free key for one request. If the key is taken, returns what holds it instead. */
  claim(key: string, record: Processing, lockMs: number): Promise<StoredRecord | undefined>;
  /** Saves the response, but only if the request holding `token` still holds the key. */
  complete(key: string, token: string, record: Done, ttlMs: number): Promise<boolean>;
  /** Frees the key so the request can be retried, if `token` still holds it. */
  release(key: string, token: string): Promise<void>;
}

export interface Options {
  store: Store;
  /** Refuse requests without a key with 400, instead of running them as usual. */
  required?: boolean;
  /** Methods that use keys. Default: POST and PATCH. */
  methods?: string[];
  /** How long a request holds its key before a retry may run instead. Default: one minute. */
  lockMs?: number;
  /** How long a response is kept for replay. Default: one day. */
  ttlMs?: number;
  /** Where the errors' `type` link points. */
  docs?: string;
}

export interface Incoming {
  method: string;
  /** The path and query. */
  path: string;
  header: string | null;
  body: Uint8Array;
  /** Separates keys, for example by user, so two clients can't collide. */
  scope: string;
}

export type Outcome =
  | { kind: "pass" }
  | { kind: "respond"; response: StoredResponse; replayed: boolean }
  | { kind: "run"; finish(response: StoredResponse): Promise<void> };

export const REPLAYED_HEADER = "idempotent-replayed";

export async function begin(options: Options, req: Incoming): Promise<Outcome> {
  const { store, lockMs = 60_000, ttlMs = 86_400_000 } = options;
  if (!(options.methods ?? ["POST", "PATCH"]).includes(req.method.toUpperCase())) return { kind: "pass" };
  const problem = (status: number, title: string, detail: string, headers: [string, string][] = []) => ({
    kind: "respond" as const,
    replayed: false,
    response: problemResponse(status, title, detail, options.docs, headers),
  });

  if (req.header === null) {
    if (!options.required) return { kind: "pass" };
    return problem(400, "Idempotency-Key is missing", "This operation requires an Idempotency-Key header.");
  }
  const key = parseKey(req.header);
  if (key === undefined) {
    return problem(400, "Idempotency-Key is invalid", "It must be a string of 1 to 255 printable ASCII characters.");
  }

  const storeKey = `${req.scope}\u0000${key}`;
  const fingerprint = fingerprintOf(req);
  const token = randomUUID();
  const existing = await store.claim(storeKey, { state: "processing", fingerprint, token }, lockMs);
  if (existing?.fingerprint !== undefined && existing.fingerprint !== fingerprint) {
    return problem(422, "Idempotency-Key is already used", "This key was used with a different request.");
  }
  if (existing?.state === "processing") {
    return problem(409, "A request is outstanding for this Idempotency-Key", "Retry once it has finished.", [
      ["retry-after", "1"],
    ]);
  }
  if (existing?.state === "done") return { kind: "respond", response: existing.response, replayed: true };

  return {
    kind: "run",
    async finish(response) {
      // A server error isn't an answer worth repeating: free the key so a retry can run.
      if (response.status >= 500) await store.release(storeKey, token);
      else await store.complete(storeKey, token, { state: "done", fingerprint, response }, ttlMs);
    },
  };
}

/**
 * Reads the header as a Structured Field String, as the draft requires: `"8e03978e-…"`. A bare
 * value without quotes is accepted too, since many clients send keys that way.
 */
export function parseKey(header: string): string | undefined {
  const text = header.trim();
  let key: string;
  if (text.startsWith('"')) {
    const match = /^"((?:[\x20\x21\x23-\x5b\x5d-\x7e]|\\["\\])*)"$/.exec(text);
    if (!match) return undefined;
    key = match[1].replace(/\\(["\\])/g, "$1");
  } else {
    if (!/^[\x21-\x7e]+$/.test(text) || text.includes('"')) return undefined;
    key = text;
  }
  return key.length >= 1 && key.length <= 255 ? key : undefined;
}

/** The method, path and body. Reusing a key for any other request gets a 422. */
function fingerprintOf(req: Incoming): string {
  return createHash("sha256").update(`${req.method.toUpperCase()} ${req.path}\n`).update(req.body).digest("hex");
}

function problemResponse(
  status: number,
  title: string,
  detail: string,
  docs = "https://github.com/Urthella/idempotency-kit#errors",
  headers: [string, string][],
): StoredResponse {
  const body = JSON.stringify({ type: docs, title, status, detail });
  return {
    status,
    headers: [["content-type", "application/problem+json"], ...headers],
    body: Buffer.from(body).toString("base64"),
  };
}

/** Headers that belong to one connection, not to the response, so they aren't replayed. */
const NOT_REPLAYED = new Set(["connection", "keep-alive", "transfer-encoding", "date", REPLAYED_HEADER]);

export function replayable(headers: Iterable<[string, string]>): [string, string][] {
  return [...headers].filter(([name]) => !NOT_REPLAYED.has(name.toLowerCase()));
}
