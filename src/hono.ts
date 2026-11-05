import type { Context, MiddlewareHandler } from "hono";

import { type Options, REPLAYED_HEADER, type StoredResponse, begin, replayable } from "./core.ts";

/** Hono middleware. Works wherever Hono does, since it only uses the fetch API. */
export function idempotency(options: Options & { scope?: (c: Context) => string }): MiddlewareHandler {
  return async (c, next) => {
    const url = new URL(c.req.url);
    const outcome = await begin(options, {
      method: c.req.method,
      path: url.pathname + url.search,
      header: c.req.header("idempotency-key") ?? null,
      body: new Uint8Array(await c.req.raw.clone().arrayBuffer()),
      scope: options.scope?.(c) ?? "",
    });
    if (outcome.kind === "pass") return next();
    if (outcome.kind === "respond") return toResponse(outcome.response, outcome.replayed);

    // Hono turns a handler's error into a 500 response before this returns, so that frees the key.
    await next();
    // ponytail: buffers the whole response; leave streaming endpoints out of `methods`.
    const body = Buffer.from(await c.res.clone().arrayBuffer()).toString("base64");
    await outcome.finish({ status: c.res.status, headers: replayable(c.res.headers), body });
  };
}

function toResponse(stored: StoredResponse, replayed: boolean): Response {
  const headers = new Headers(stored.headers);
  if (replayed) headers.set(REPLAYED_HEADER, "true");
  // 204 and 304 can't have a body.
  const body = stored.status === 204 || stored.status === 304 ? null : Buffer.from(stored.body, "base64");
  return new Response(body, { status: stored.status, headers });
}
