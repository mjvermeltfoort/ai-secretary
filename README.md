# AI Vergadersecretaris

Android/Chromebook-app voor betrouwbare vergaderopnames, live transcriptie en notulen.

## Stack

- React + TypeScript + Vite
- Capacitor
- Native Android recording module in Kotlin
- Firebase Auth, Firestore, Storage en Cloud Functions
- OpenAI alleen server-side
- Google OAuth voor Google Docs

## Lokale setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

Firebase CLI-projectkoppeling:

```bash
npx -y firebase-tools@latest use ai-vergadersecretaris
npx -y firebase-tools@latest emulators:start
```

Android wordt gegenereerd zodra Capacitor CLI en Android SDK beschikbaar zijn:

```bash
npm run build
npx cap add android
npx cap sync android
```

## Firebase-project

Firebase-project `ai-vergadersecretaris` bestaat. Web- en Android-app zijn geregistreerd. Firestore Standard draait in `europe-west1`; Google Sign-In is geactiveerd. Storage-bucket is bewust niet aangemaakt, omdat Firebase hiervoor billing vraagt. De repository activeert geen betaalde diensten.

## Veiligheid

- Commit nooit `.env*`, `google-services.json`, signing keys of OpenAI-sleutels.
- Review prototype-regels vóór productie.
- Gebruik App Check, server-side secrets en minimale OAuth-scopes vóór release.
- Transcriptie gebruikt server-side `gpt-transcribe`; zet OpenAI-key alleen in Secret Manager of `functions/.secret.local` voor lokale emulator-tests.

## Live notulist

Kies **Praat met de notulist** voor een live gesprek met spraak en tekst.
Zie [LIVE_NOTULIST.md](docs/LIVE_NOTULIST.md) voor bediening, bevestigde
actiepuntcorrecties, architectuur en de eerste praktijktest.
