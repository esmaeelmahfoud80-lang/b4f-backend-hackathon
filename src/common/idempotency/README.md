# Shared idempotency

Import `IdempotencyModule` in the feature module. On an authenticated route, use `@CurrentActor()` and `@IdempotencyKey()`. Pass the actor’s trusted `userId`, a stable operation name, the validated UUID, and a plain JSON payload to `IdempotencyService.execute()`. Include any target route ID and normalize defaults before fingerprinting so equivalent requests use the same data. Keep timestamps and generated IDs out of the request fingerprint.

The service opens a PostgreSQL `READ COMMITTED` transaction and claims `(actor_id, operation, request_key)` before executing the callback. Type all participating database helpers to take the supplied `Prisma.TransactionClient`, and pass it through every read, row lock, and write. An independently injected root client or nested transaction is outside the atomic boundary. Perform mutable ownership, balance and state checks inside the callback, after the claim. Keep external side effects outside this flow.

```ts
return this.idempotency.execute(
  { actorId: actor.userId, operation: 'feature.operation', key, payload: { targetId, amountSyp } },
  async (tx) => {
    const body = await this.featureMutation(tx, actor, targetId, amountSyp);
    return { statusCode: 201, body };
  },
);
```

Return the service’s status and body to the HTTP caller. The callback should return a plain JSON DTO with database decimals, bigints and dates mapped to their contract types. Use `body: null` for a response with no body and omit the body when writing HTTP 204.

Concurrent claims are serialized by the primary key. A successful retry returns the saved status and body. A different payload gets `409 IDEMPOTENCY_KEY_REUSED`. Throwing from the callback rolls back both the claim and its writes. Operations should remain short enough for Prisma’s interactive transaction timeout. The helper does not automatically rerun business callbacks after database failures.
