# Enabling the message TTL policy

Every message carries an `expireAt` timestamp (`sentAt + 30 days`, set in
`shared/schema.js`). This is the safety net from build doc §3.3: messages sent to
an account that never comes back to ack them would otherwise sit in Firestore
forever.

**This requires the Blaze (pay-as-you-go) plan.** On Spark, the API rejects the
request with `403 ... has billing disabled`.

Once billing is enabled, add the field override back to
`firestore.indexes.json`:

```json
{
  "indexes": [],
  "fieldOverrides": [
    {
      "collectionGroup": "messages",
      "fieldPath": "expireAt",
      "ttl": true,
      "indexes": []
    }
  ]
}
```

and deploy:

```bash
firebase deploy --only firestore:indexes
```

Until then, cleanup relies on the client-side sweep: once `pendingFor` is empty,
the sender deletes the message. That covers every delivered message, which is the
common case.
