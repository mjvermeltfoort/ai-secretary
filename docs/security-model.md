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

## Owner-only test phase

Only the verified Google account `mjvermeltfoort@gmail.com` may use the app.
Functions check the Firebase ID token before input processing, database access or
OpenAI requests. Firestore and Storage rules require the same email,
`email_verified == true`, and `firebase.sign_in_provider == google.com`, while
retaining per-UID ownership. Client checks are only for user experience.

This restricts app/data access, not Firebase Auth account creation: another Google
account may complete sign-in, but sees **Geen toegang** and is denied by the
backend. Existing authenticated sessions are also subject to the server rules.
The website and Firebase web configuration remain public.

Keep the owner address synchronized in `functions/src/access.ts`,
`src/lib/access.ts`, `firestore.rules`, `storage.rules` and tests.
Automated tests cover allowed owner access and reject anonymous users, other
Google accounts (including their own paths), unverified emails, other login
providers, wrong UIDs, ownership changes and invalid meeting data.

Run `npm test`, `npm run test:rules`, `npm run build` and
`npm --prefix functions run build`. Rules tests use a demo project and make no
production changes or AI calls.

Merge and successfully deploy Hosting, Functions and Firestore to activate the
restriction. The main workflow performs that deployment automatically. Storage
rules must also be deployed with `firebase deploy --only storage` if a Storage
bucket is in use; the current app sends audio directly to the callable Function.
Do not create a bucket solely for this change.

These are prototype Security Rules, with focused access tests, not an exhaustive
security review. Review before broad distribution. Local IndexedDB audio remains
on the browser profile and is not protected by Firebase rules; use your own device
or browser profile.
