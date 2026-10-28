# AI gateway

Optional Cloud Run service for workloads that need longer execution time than a callable Function.

Rules:

- Accept only Firebase ID tokens from the app.
- Read OpenAI credentials from Secret Manager.
- Never log audio, transcript text, OAuth tokens or API keys.
- Store only derived meeting data in Firestore.
- Use a European region when supported and approved.

Start with Cloud Functions. Move a specific workload here only after measured timeout, memory or streaming needs justify Cloud Run.
