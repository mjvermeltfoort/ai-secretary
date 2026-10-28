# Implementatieplan — AI Vergadersecretaris

## Status

- [x] React + TypeScript + Vite basis
- [x] Capacitor-configuratie
- [x] Firebase CLI-configuratie voor Auth, Firestore, Storage en Functions
- [x] Prototype Firestore- en Storage-regels
- [x] Herstelmodel en unit-tests
- [x] Server-side OpenAI transcriptie-endpoint
- [x] Transcriptie-UI met Google-login en Firestore-resultaat
- [x] Firebase-project online aanmaken
- [x] Web- en Android-app registreren
- [x] `google-services.json` ophalen
- [x] Firestore/Auth activeren zonder betaalde diensten
- [ ] Storage-bucket activeren — Firebase vereist hiervoor billing in dit project; bewust niet geactiveerd
- [ ] Android-project genereren en Kotlin-opnamemodule koppelen
- [ ] `OPENAI_API_KEY` via Secret Manager instellen — vereist expliciete kosten/toestemming
- [ ] Transcriptie-Function deployen — vereist betaalde Firebase-capaciteit

## Fasen

1. **Foundation** — project, Firebase-config, lokale emulators, CI.
2. **Recording** — foreground recording service, segmenten, lokale append-only opslag, checksums.
3. **Sync** — resumable upload, offline queue, sessiewissels, ontbrekende segmenten.
4. **AI** — server-side OpenAI gateway voor transcriptie, samenvatting en vragen.
5. **Meeting data** — besluiten, actiepunten, eigenaar/deadline-validatie en historie.
6. **Google Docs** — Google OAuth met minimale Docs-scope en gecontroleerde documentupdates.
7. **Hardening** — regels, App Check, rate limits, observability, export en verwijdering.
8. **Release** — Chromebook/Android UX, lange-opnametests, hersteltests, Play-release.

## Ontwerpkeuzes

- Opnamebestanden blijven lokaal beschikbaar buiten de AI-sessie.
- De recorder schrijft kleine, genummerde segmenten met checksum.
- Firebase bewaart metadata en cloud-kopieën; ontbrekende segmenten worden opnieuw geüpload.
- OpenAI-sleutels blijven uitsluitend in server-side Functions/Cloud Run secrets.
- Europese regio wordt gekozen bij provisioning, na controle van beschikbare locaties.
- Geen billing-upgrade, Cloud Run autoscaling of andere betaalde dienst zonder toestemming.
