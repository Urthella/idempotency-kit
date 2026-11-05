import type { Request, RequestHandler } from "express";

import { type Options, REPLAYED_HEADER, begin, replayable } from "./core.ts";

/**
 * Express middleware. Put it after your body parser: the fingerprint uses the parsed body, or
 * the raw bytes with `express.raw()`.
 */
export function idempotency(options: Options & { scope?: (req: Request) => string }): RequestHandler {
  return async (req, res, next) => {
    let outcome;
    try {
      outcome = await begin(options, {
        method: req.method,
        path: req.originalUrl,
        header: req.get("idempotency-key") ?? null,
        body: bodyBytes(req.body),
        scope: options.scope?.(req) ?? "",
      });
    } catch (e) {
      return next(e);
    }
    if (outcome.kind === "pass") return next();
    if (outcome.kind === "respond") {
      res.status(outcome.response.status);
      for (const [name, value] of outcome.response.headers) res.append(name, value);
      if (outcome.replayed) res.set(REPLAYED_HEADER, "true");
      res.end(Buffer.from(outcome.response.body, "base64"));
      return;
    }

    // Keep a copy of what the handler sends, to replay it later.
    // ponytail: buffers the whole response; leave streaming endpoints out of `methods`.
    const chunks: Buffer[] = [];
    const keep = (chunk: unknown, encoding?: unknown) => {
      if (typeof chunk === "string") chunks.push(Buffer.from(chunk, typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8"));
      else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
    };
    const write = res.write.bind(res) as (...args: unknown[]) => boolean;
    const end = res.end.bind(res) as (...args: unknown[]) => typeof res;
    res.write = ((chunk: unknown, ...rest: unknown[]) => (keep(chunk, rest[0]), write(chunk, ...rest))) as typeof res.write;
    // Saved when the handler ends its response, even if the client has gone: the work is done,
    // so a retry should get this response rather than run it again.
    res.end = ((chunk?: unknown, ...rest: unknown[]) => {
      keep(chunk, rest[0]);
      const result = end(chunk, ...rest);
      const headers = Object.entries(res.getHeaders()).flatMap(([name, value]) =>
        (Array.isArray(value) ? value : [value]).map((v) => [name, String(v)] as [string, string]),
      );
      const response = { status: res.statusCode, headers: replayable(headers), body: Buffer.concat(chunks).toString("base64") };
      outcome.finish(response).catch((e) => console.error("idempotency: couldn't save the response", e));
      return result;
    }) as typeof res.end;
    next();
  };
}

function bodyBytes(body: unknown): Uint8Array {
  if (body === undefined || body === null) return new Uint8Array();
  if (body instanceof Uint8Array) return body;
  return Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
}
