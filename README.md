# idempotency-kit

[![ci](https://github.com/Urthella/idempotency-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/Urthella/idempotency-kit/actions/workflows/ci.yml)

Idempotency-Key middleware for Express, Fastify and Hono, following the IETF draft
([draft-ietf-httpapi-idempotency-key-header-08](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/)).
A client that retries a payment after a timeout gets the first response back, and the payment
runs once. Keys live in memory or in Redis.

```
$ curl -X POST localhost:3000/payments -H 'Idempotency-Key: "k1"' -d '{"amount":5}'   # while the first one runs
409 {"title":"A request is outstanding for this Idempotency-Key", …}
$ curl -X POST localhost:3000/payments -H 'Idempotency-Key: "k1"' -d '{"amount":5}'   # after
201 {"id":"f72cff02-…","amount":5}          Idempotent-Replayed: true
$ curl -X POST localhost:3000/payments -H 'Idempotency-Key: "k1"' -d '{"amount":6}'
422 {"title":"Idempotency-Key is already used", …}
```

That's [examples/express.ts](examples/express.ts), run with curl. The handler charged once.

## Use it

Express, after the body parser:

```ts
import { idempotency } from "./src/express.ts";
import { redisStore } from "./src/stores.ts";

app.use(express.json());
app.use(idempotency({ store: redisStore(redis), scope: (req) => req.user.id }));
```

Fastify, registered before the routes it covers:

```ts
import { idempotency } from "./src/fastify.ts";

await app.register(idempotency({ store: redisStore(redis) }));
```

Hono:

```ts
import { idempotency } from "./src/hono.ts";

app.use(idempotency({ store: redisStore(redis) }));
```

`redis` is a [node-redis](https://github.com/redis/node-redis) client. Any other client works
through a `{ sendCommand(args) }` wrapper; for ioredis, `(args) => client.call(args[0], ...args.slice(1))`.
`memoryStore()` is for tests and single-process servers.

| Option | Default | |
| --- | --- | --- |
| `store` | | where keys are kept |
| `scope` | none | keeps keys apart, for example by user, so two clients can't collide |
| `required` | `false` | refuse requests without a key with 400, instead of running them as usual |
| `methods` | `POST`, `PATCH` | which methods use keys |
| `lockMs` | 1 minute | how long a request holds its key before a retry may run instead |
| `ttlMs` | 1 day | how long a response is kept for replay |
| `docs` | this README | the link in error responses |

The repo isn't published to npm; copy `src/` or clone it. Node 24 runs the TypeScript directly.

## What it does

| Request | Response |
| --- | --- |
| A new key | runs the handler and saves its response |
| The same key and request again | the saved response, with `Idempotent-Replayed: true` |
| The same key while the first is still running | `409 Conflict`, with `Retry-After: 1` |
| The same key with a different method, path or body | `422 Unprocessable Content` |
| A key that isn't a valid string | `400 Bad Request` |
| No key, with `required: true` | `400 Bad Request` |

<a id="errors"></a>Errors are `application/problem+json` (RFC 9457), as in the draft's examples.

Some choices the draft leaves open:

- **Keys** are Structured Field Strings, `"8e03978e-…"`, as the draft requires. Bare values
  without quotes are accepted too, since many clients send them that way. A key is 1 to 255
  printable ASCII characters.
- **The fingerprint** is a SHA-256 of the method, path with query, and body. With Express, that's
  the parsed body, or the raw bytes if you use `express.raw()`.
- **Server errors aren't saved.** A 5xx frees the key so a retry runs again. A 4xx is an answer
  and is replayed.
- **A response is saved when the handler finishes it**, even if the client has hung up by then.
  The work happened, so a retry should get its result, not run it again.

## Where it can still run twice

A request holds its key for `lockMs`. If the handler takes longer than that, or the process dies
mid-request, the key frees up and a retry runs the handler again. The first handler can't save
its response afterwards, since it no longer holds the key, but whatever it did has happened. Set
`lockMs` above your slowest request, and make the work itself safe to repeat where it matters,
for example with a unique constraint in the database.

## How it's tested

37 tests, and 5 more for the Redis store that run against a real Redis in CI. The same checks
run against Express and Fastify, over real HTTP, and Hono. They cover replays, twenty requests at
once with one key (the handler runs once, nineteen get 409), a different body, a handler that
throws, a body written in pieces, scopes, and, for Express, a client that hangs up mid-request.
Both stores pass the same contract tests, the Redis one against a real Redis in CI.

To check that the tests can fail, 19 bugs were planted one at a time in the core, the three
adapters and the memory store, and every one was caught. One real bug turned up while writing them: the
Express adapter first freed the key when a client hung up, so a retry would have run the
handler a second time.

## Limits

- **Whole responses are buffered**, so streaming endpoints should be left out of `methods`.
- **The memory store** forgets everything on restart, isn't shared between processes, and drops
  expired keys only when they're used again.
- **The Redis store** has only been run against a single Redis, not a cluster.
- **Fastify streams aren't replayed.** A route that sends a stream frees its key afterwards, so
  a retry runs it again.

Claude, Anthropic's AI model, wrote this with Halil Utku Demirtaş directing the work.

## License

MIT
