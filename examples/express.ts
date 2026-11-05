// node examples/express.ts, then: curl -X POST localhost:3000/payments -H 'Idempotency-Key: "k1"' -d '{"amount":5}'
import { randomUUID } from "node:crypto";

import express from "express";

import { idempotency } from "../src/express.ts";
import { memoryStore } from "../src/stores.ts";

const app = express();
app.use(express.json({ type: () => true }));
app.use(idempotency({ store: memoryStore(), required: true }));

app.post("/payments", async (req, res) => {
  await new Promise((resolve) => setTimeout(resolve, 1000)); // pretend to call the bank
  const payment = { id: randomUUID(), amount: req.body.amount };
  console.log("charged", payment);
  res.status(201).json(payment);
});

app.listen(Number(process.env.PORT ?? 3000), () => console.log("listening"));
