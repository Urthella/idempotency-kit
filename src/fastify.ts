import type { FastifyInstance, FastifyRequest } from "fastify";

import { type Options, type Outcome, REPLAYED_HEADER, begin, replayable } from "./core.ts";

type Running = Extract<Outcome, { kind: "run" }>;

/**
 * A Fastify plugin: `app.register(idempotency({ store }))`. It covers every route registered
 * after it, like a plugin wrapped in fastify-plugin.
 */
export function idempotency(options: Options & { scope?: (req: FastifyRequest) => string }) {
  const running = new WeakMap<FastifyRequest, Running>();
  const plugin = async (app: FastifyInstance) => {
    // preHandler runs after the body is parsed, so the fingerprint can include it.
    app.addHook("preHandler", async (req, reply) => {
      const outcome = await begin(options, {
        method: req.method,
        path: req.url,
        header: req.headers["idempotency-key"]?.toString() ?? null,
        body: bodyBytes(req.body),
        scope: options.scope?.(req) ?? "",
      });
      if (outcome.kind === "run") running.set(req, outcome);
      if (outcome.kind !== "respond") return;
      reply.code(outcome.response.status);
      for (const [name, value] of outcome.response.headers) reply.header(name, value);
      if (outcome.replayed) reply.header(REPLAYED_HEADER, "true");
      return reply.send(Buffer.from(outcome.response.body, "base64"));
    });

    // onSend sees the serialized body, and runs for errors too, which then free the key.
    app.addHook("onSend", async (req, reply, payload) => {
      const outcome = running.get(req);
      if (!outcome) return payload;
      running.delete(req);
      const body = typeof payload === "string" ? Buffer.from(payload) : payload instanceof Uint8Array ? payload : undefined;
      // A stream can't be kept for replay, so it's treated like a failure and the key is freed.
      // ponytail: leave streaming routes out of `methods`.
      const headers = Object.entries(reply.getHeaders()).flatMap(([name, value]) =>
        (Array.isArray(value) ? value : [value]).map((v) => [name, String(v)] as [string, string]),
      );
      await outcome.finish(
        body === undefined
          ? { status: 500, headers: [], body: "" }
          : { status: reply.statusCode, headers: replayable(headers), body: Buffer.from(body).toString("base64") },
      );
      return payload;
    });
  };
  // What fastify-plugin does: the hooks apply outside this plugin's own scope too.
  return Object.assign(plugin, { [Symbol.for("skip-override")]: true });
}

function bodyBytes(body: unknown): Uint8Array {
  if (body === undefined || body === null) return new Uint8Array();
  if (body instanceof Uint8Array) return body;
  return Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
}
