# Eerste ingebruikname

## GitHub Actions

Voeg onder Settings → Secrets and variables → Actions een repository secret toe:
`VITE_FIREBASE_API_KEY`, met de Firebase-web-API-key als waarde.

CI neemt de overige openbare webconfiguratie over uit `.env.example` en geeft
de API-key als omgevingsvariabele door aan Vite. Een push op main faalt met een
duidelijke melding als de secret ontbreekt. Pull requests uit forks krijgen geen
repository secrets en kunnen alleen de compilatie en tests controleren.

Vite verwerkt de webconfiguratie tijdens de build. Een key die later wordt
toegevoegd vereist dus een nieuwe build. De huidige CI test en bouwt, maar
publiceert nog niet naar Firebase. Een Firebase-web-API-key geeft geen
deployrechten. Firestore-regels en Firebase Authentication beveiligen de data.

## Eenmalig publiceren vanuit een terminal met Firebase-toegang

1. Installeer Node.js 22 en haal de repository op.
2. Voer `npm ci` uit.
3. Kopieer `.env.example` naar `.env.local` en vul lokaal
   `VITE_FIREBASE_API_KEY` in. GitHub Actions secrets worden niet lokaal ingelezen.
4. Bouw de webapp en Functions:

```bash
npm test
npm run build
npm --prefix functions run build
```

5. Meld je aan en selecteer het bestaande project:

```bash
npx -y firebase-tools@latest login
npx -y firebase-tools@latest use ai-vergadersecretaris
```

6. Stel de OpenAI-key interactief in via Firebase Secret Manager:

```bash
npx -y firebase-tools@latest functions:secrets:set OPENAI_API_KEY
```

Gebruik hiervoor een OpenAI API-key met API-budget. Deel de waarde niet in chat
of GitHub. Deze key hoort uitsluitend op de server, zonder `VITE_`-prefix.

7. Deploy na controle van de Firestore-regels:

```bash
npx -y firebase-tools@latest deploy --only hosting,functions,firestore --project ai-vergadersecretaris
```

Cloud Functions en OpenAI kunnen kosten maken. De bovenstaande handmatige
deploy-opdracht publiceert de app en serverfuncties. Storage is niet opgenomen:
de huidige transcriptie stuurt lokale audiosegmenten direct naar een callable
Function en heeft voor deze test geen Storage-bucket nodig.

8. Controleer in Firebase Console → Authentication → Settings → Authorized domains
   dat het door Firebase Hosting getoonde domein is toegestaan. Controleer ook of
   Google als aanmeldprovider is ingeschakeld. Het `auth`-blok in `firebase.json`
   vervangt deze controle in de Console niet.

## Eerste volledige test

Open de URL uit de Hosting-deploy in Chrome, log in met Google en geef
microfoontoegang. Neem ongeveer 30 seconden Nederlandse tekst op met een besluit
en een actiepunt. Stop, wacht totdat alle segmenten zijn getranscribeerd en kies
**Genereer notulen**.

Controleer transcript, samenvatting, besluiten en actiepunten. Herhaal met een
tweede sessie. Controleer bij fouten de browserconsole en de Firebase Functions-logs.

Dit valideert het browserprototype. De native Android-opnamemodule, opname bij
vergrendeld scherm, Google Docs-koppeling en pratende notulist zijn nog geen
onderdeel van deze eerste test. Herstel na herladen moet apart worden getest:
de huidige interface begint bij herladen met een nieuwe sessie.
