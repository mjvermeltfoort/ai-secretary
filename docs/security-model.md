# Security model input

## Firestore paths

- `users/{uid}` — private profile metadata.
- `users/{uid}/meetings/{meetingId}` — meeting metadata owned by `uid`.
- `users/{uid}/meetings/{meetingId}/segments/{segmentId}` — segment metadata.
- `users/{uid}/meetings/{meetingId}/transcripts/{chunkId}` — transcript chunks.
- `users/{uid}/meetings/{meetingId}/actionItems/{itemId}` — action items.

## Access pattern

- Firebase Auth is required for all reads and writes.
- A user can access only documents below their own `users/{uid}` path.
- Clients never write privileged roles or server-owned timestamps.
- Functions may use Admin SDK for server-side processing.

## Query assumptions

- Initial client queries are scoped by path and may order meeting lists by `startedAt`.
- No public collection exists.
- No cross-user query is required.

## Rules status

The generated rules are a prototype. Review them against final schema and emulator tests before production deployment.
