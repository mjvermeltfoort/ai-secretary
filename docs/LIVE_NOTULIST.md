> Deze functionaliteit is nu onderdeel van één doorlopende vergadering.
> Zie [CONTINUOUS_MEETING.md](CONTINUOUS_MEETING.md) voor de actuele opname-,
> live-transcriptie- en herstelopzet. Tijdens opname deelt overleg de
> microfoonbron via een clone; beide verbindingen behouden hun eigen lifecycle.

# Live notulist — eerste versie

## Gebruik

Log in met het toegestane Google-account en kies **Praat met de notulist**.
De AI-stem is synthetisch. Geef microfoontoegang en stel je vraag. Je kunt
hardop onderbreken, **Onderbreek antwoord** kiezen of een vraag typen.
**Microfoon uit** houdt getypte vragen beschikbaar. **Terug naar meeluisteren**
sluit de spraakverbinding en geeft de microfoon voor dit gesprek vrij.

De lokale vergaderopname heeft een eigen stream en blijft onafhankelijk werken.
De notulist ziet alleen de beschikbare transcriptie en notulen, niet nog niet
getranscribeerde audio. Gebruik oortjes: de digitale AI-uitvoer wordt niet aan het
vergadertranscript toegevoegd, maar een luidspreker kan akoestisch via de
vergadermicrofoon opnieuw worden opgenomen. Browser-achtergrondopname en een
vergrendeld Android-scherm blijven beperkingen van het bestaande browserprototype.

Een gesprek sluit na vijf minuten; je kunt daarna opnieuw verbinden. Dit is een
clientlimiet, geen harde financiële limiet op het OpenAI-project. Alleen actieve
gesprekken versturen microfoonaudio naar de Realtime API. Een nieuwe verbinding
begint een nieuwe AI-conversatie met de huidige vergadercontext; eerdere
chatberichten blijven lokaal zichtbaar maar zijn geen hersteld AI-geheugen.

## Actiepunt corrigeren

1. Genereer eerst notulen met actiepunten.
2. Vraag bijvoorbeeld: “Verander de eigenaar van het eerste actiepunt naar Mark.”
3. De notulist gebruikt een tool die uitsluitend een voorstel in de app toont.
4. Controleer omschrijving, eigenaar en deadline, en kies **Wijziging opslaan**.
5. De server bewaart het gewijzigde actiepunt met een nieuwe revisie. Verouderde
   voorstellen worden geweigerd. **Afwijzen** verandert niets.

De wijziging geldt voor de actiepuntenlijst. De samenvatting en besluiten worden
niet herschreven. Opnieuw notulen genereren uit de originele transcriptie vervangt
de notulen en kan handmatige correcties overschrijven; doe dat bewust.

## Implementatie

- `createVoiceSession`: owner-controle vóór toegang tot `OPENAI_API_KEY`; maakt een
  client secret dat 60 seconden geldig is. De gewone API-key wordt nooit naar de
  browser gestuurd of gelogd. Model: `gpt-realtime-2.1`; stem: `marin`.
- WebRTC: browser verbindt rechtstreeks met OpenAI via `/v1/realtime/calls`, met
  een eigen microfoonstream en datachannel voor events en chattekst.
- VAD staat alleen in de expliciet gestarte gespreksverbinding aan. Het kan
  antwoorden en onderbreken. In meeluisterstand bestaat deze verbinding niet.
- De client vernieuwt de instructies met een begrensd fragment van de huidige
  vergadering. Actiepunten worden volledig opgenomen of weggelaten; nooit
  afgekapt voordat een wijziging wordt voorgesteld. Transcript en notulen zijn
  brongegevens, geen opdrachten. Toolvoorstellen zijn gebonden aan hun revisie.
- `updateMeetingActionItem`: owner-controle, veldvalidatie en een Firestore-
  transactie met controle op de verwachte revisie. AI-tools wijzigen niets zonder
  de bevestigingsactie in de app. De client kan geen servercredentials kiezen.
- Gespreksberichten staan apart van meeting transcripts en worden vooralsnog
  alleen in het geheugen van deze pagina bewaard. Sessiewissel, uitloggen en
  unmount sluiten de verbinding; foutafhandeling stopt de eigen tracks.

De bestaande deployment op main publiceert de twee nieuwe callable Functions en
de webapp. Geen nieuwe secrets, providers, database-regels of Google Docs-scopes
nodig. Het bestaande OpenAI-project moet toegang tot het realtime model hebben.

## Verificatie

`npm test` test authenticatie, tijdelijke secrets met gemockte HTTP-verzoeken,
actiepuntvalidatie/revisies, contextisolatie, WebRTC-lifecycle en onderbrekingen.
`npm run build` en `npm --prefix functions run build` controleren TypeScript en
productie-builds. De bestaande emulatorcontroles blijven onderdeel van CI.

Praktijktest na deployment: vraag hardop naar besluiten, onderbreek het antwoord,
typ een vervolgvraag, bevestig/annuleer een actiepuntvoorstel, wissel van sessie en
controleer dat de aparte vergaderopname blijft doorlopen. Test een verloren
verbinding en probeer met een ander Google-account; dat mag geen spraaktoegang
of wijzigingen krijgen. Automatische tests doen geen betaalde OpenAI-aanroepen.

Bronnen voor de implementatie:
- https://developers.openai.com/api/docs/guides/voice-webrtc?voice-api=realtime
- https://developers.openai.com/api/docs/guides/realtime-conversations
- https://developers.openai.com/api/reference/resources/realtime/subresources/client_secrets/methods/create
