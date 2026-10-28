# Architectuur

```text
Kotlin foreground recorder
        |
        v
lokale segmenten + checksums ----> Firebase Storage
        |                                  |
        +--> sync queue ------------------> Firestore metadata
                                           |
                              Cloud Functions / Cloud Run
                                           |
                                  OpenAI + Google Docs
```

## Data-eigenaarschap

- Recorder owns local audio and upload queue.
- Firebase owns authenticated metadata and cloud copies.
- AI service owns transient processing and derived transcript/notulen.
- Google Docs integration owns only explicitly requested document updates.

## Region and billing

Use `europe-west1` for Firestore. Keep development on emulator and free-tier-compatible services. Storage-bucket provisioning is blocked until billing is explicitly approved. Do not enable billing or paid capacity without explicit approval.
