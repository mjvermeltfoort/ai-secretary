# Eén vergadering: opnemen, live volgen en overleggen

## Bediening

**Start vergadering** start één doorlopende microfoonopname. De live tekst en
het overleg met de notulist gebruiken dezelfde vergadering. **Praat met de
notulist** bereidt een samenvatting van de beschikbare afgeronde transcriptie voor en opent daarmee het overleg. De algemene samenvatting is ook zichtbaar en afzonderlijk bij te werken onder **Wat is er besproken?**. Tijdens een
opname gebruikt dit overleg een eigen clone van dezelfde microfoonbron; stoppen
met overleggen stopt de recorder niet. Aanspreken met **Kneut** opent hetzelfde
gesprek als de gespreksknop en sluit de live transcriptieverbinding tijdelijk.
**Terug naar meeluisteren** hervat die verbinding en werkt opgeslagen audio bij. De AI-antwoorden worden afzonderlijk
weergegeven en zijn geen officiële vergaderbesluiten. Actiepuntwijzigingen blijven
voorstellen die expliciet bevestigd moeten worden.

**Pauzeer** onderbreekt de opname en sluit de live transcriptie; overleg blijft
beschikbaar. **Hervat vergadering** hervat dezelfde audiograaf en dezelfde sessie.
**Afronden** sluit het overleg, bewaart het laatste audiostuk, stopt de
microfoonopname en start de controle vanuit de lokale audio. Daarna kan de
gebruiker **Maak definitieve notulen** kiezen. De notulist kan ook na afronden over
de verwerkte tekst en notulen worden geraadpleegd.

## Compacte interface

De kop toont de opnamestatus en opgenomen tijd (op basis van bewaarde audio; bijgewerkt per audioblok, pauzes tellen niet mee). Starten/hervatten, pauzeren en afronden blijven direct bereikbaar. Het optiemenu **⋮** bevat nieuwe/eerdere vergaderingen, beschikbare downloads, Help en het account. Buiten het menu klikken of Escape sluit het menu.

Onder Kneut staan de actuele gespreksknoppen en **Vragen stellen: Bij overgangen / Na afloop**. Een afgerond gesprek is ingeklapt onder **Bekijk laatste gesprek**. Samenvatting, Live tekst en Notulen hebben ieder een tabblad; wisselen start of stopt geen opname, transcriptie of spraakverbinding. Pijltoetsen, Home en End bedienen de tabbladen. Definitieve notulen kunnen op het tabblad Notulen worden aangemaakt zodra de opname is afgerond.

Algemene uitleg staat onder Help; technische opnamegegevens onder Details. Opslagwaarschuwingen, opnamefouten en herstelproblemen blijven buiten de tabbladen zichtbaar. Transcriptievoortgang blijft tijdens verwerken zichtbaar. De opnamestatus wordt één keer in de kop getoond, live regels hebben geen herhaald Live-label.

## Audio en transcriptie

- Eén AudioWorklet leest doorlopend mono PCM op 24 kHz. Opslaan herstart nooit de
  microfoon of recorder. Kleine zelfstandig afspeelbare WAV-bestanden worden
  ongeveer iedere twee seconden in IndexedDB vastgelegd. De opslagtransactie
  moet voltooid zijn voordat een blok als bewaard wordt gemeld.
- Live transcriptie gebruikt `gpt-live-transcribe` via een WebSocket met een
  server-aangemaakt tijdelijk token. Deze route gebruikt geen permanente key in
  de browser. De eigen PCM-stroom voedt zowel opslag als transcriptie.
- Een eenvoudige client-VAD bewaart een korte aanloop en commit bij circa 900 ms
  stilte; langdurige ononderbroken spraak krijgt een technische bovengrens van
  60 seconden per turn. De verbinding zelf wordt daarbij niet herstart. Tekst is
  live en voorlopig. Completion-events worden op input-item-ID geordend.
- Bij netwerkproblemen wordt de live verbinding automatisch hersteld, met replay
  vanuit opgeslagen WAV-blokken en een transactioneel bewaarde tekst-/samplecursor.
  Opname blijft onafhankelijk doorlopen. De live route verstuurt uitsluitend reeds
  opgeslagen audio; aanvoer heeft daardoor circa twee seconden extra vertraging.
  Tijdens inhalen blijft Kneut stil. Zie RECORDING_RECOVERY.md voor de grenzen.
- De controle gebruikt vensters van maximaal 60 seconden, met vier seconden
  overlap. WAV-samples worden exact samengevoegd over opslaggrenzen heen. Er
  hoeft dus geen zin in een lokaal opslagblok te passen. Eerder opgenomen
  zelfstandige WebM/MP4-bestanden worden waar de browser dat ondersteunt eerst
  gedecodeerd naar PCM; de originele bestanden worden niet verwijderd.
- `gpt-transcribe` krijgt de vorige tekst als context. Een exact overeenkomende
  woordoverlap wordt verwijderd; twijfelachtige grenzen blijven intact met een
  zichtbare controlemarkering. Er wordt bij twijfel geen tekst stilzwijgend
  weggelaten. Dit blijft automatische transcriptie, geen garantie van foutloze
  woorden of van het verstaan van overlappende stemmen.
- Alleen een complete, aaneengesloten reeks audiovensters wordt gepubliceerd als
  verwerkte transcriptie. Notulen gebruiken die tekst. Vensters zijn gecachet
  per herstelronde en audiohash, zodat opnieuw proberen reeds voltooide
  transcriptieverzoeken hergebruikt. Er is geen sprekerherkenning toegevoegd.

## Bewaren en herstellen

De actieve sessie wordt lokaal onthouden en lokaal aanwezige vergaderingen zijn
via de keuzelijst terug te openen, met bewaarde tekst en laatst gegenereerde notulen.
De opname kan worden hervat, geëxporteerd en opnieuw verwerkt.
Audio wordt niet automatisch verwijderd. Sluiten/crashen kan het nog niet
vastgelegde laatste blok verliezen. De gebruiker moet tijdens gebruik voldoende
lokale opslag houden (ongeveer 170 MB per opname-uur). Browseropslag is geen
externe back-up en is toegankelijk binnen hetzelfde browserprofiel.

Bij offline afronden wordt de microfoon onmiddellijk gestopt; de audio blijft
beschikbaar en de gebruiker kan de controle later opnieuw starten. Definitieve
notulen worden pas gemaakt nadat de audioverwerking volledig is afgerond.
Live transcriptie, overleg en verwerking achteraf verbruiken het OpenAI-budget.
Alleen het overleg heeft de bestaande limiet van vijf minuten per verbinding;
live transcriptie volgt de opname. Dat zijn geen harde financiële accountlimieten.

## Server en beveiliging

`createTranscriptionSession`, `transcribeAudioWindow` en
`finalizeReviewedTranscript` controleren het toegestane geverifieerde
Google-account vóór API- of databasewerk. De bestaande toegangsbeperking blijft
behouden. Herstelresultaten staan onder de eigen meeting in `transcriptRuns`;
clienttoegang tot die subcollectie blijft standaard geweigerd. Admin SDK-functions
lezen en schrijven uitsluitend binnen de UID van het gecontroleerde token.

De server valideert WAV-header, sampleformaat, payloadgrootte, audioduur,
volgorde, voortgang en het aantal vensters. Een incompleet herstel vervangt de
gepubliceerde transcriptie niet. Nieuwe audiovensters na hervatten leveren een
nieuwe herstelronde op. De gewone OpenAI-key blijft in Secret Manager.

## Verificatie en grenzen

Unit- en integratietests controleren samplebehoud, WAV-validatie, overlap,
herstelvolgorde, oude audio, authenticatie, eventvolgorde en de gezamenlijke
bediening. Een Chromium-browsertest gebruikt echte Web Audio/AudioWorklet en een
synthetisch microfoonapparaat: opgenomen samples komen exact terug in de lokale
WAV-bestanden, ook over pauzeren/hervatten heen, met één audiograaf. AI-verzoeken
zijn in deze browser- en unit-tests gemockt; er worden geen betaalde calls gedaan.

De bestaande Android-/Chrome-achtergrondbeperkingen blijven gelden. Test lange
vergaderingen en het concrete apparaat met echte stemmen. Voor uitsluitend
spreken met de AI is een afzonderlijke microfoonaanvraag nodig als er nog geen
vergaderopname actief is. Gebruik oortjes om akoestisch opnieuw opnemen van de
AI-stem te voorkomen. Sprekerlabels en scheiding van gelijktijdige stemmen vallen
buiten deze wijziging.

Bronnen:
- https://developers.openai.com/api/docs/guides/realtime-transcription
- https://developers.openai.com/api/docs/guides/voice-websockets?voice-api=realtime
- https://developers.openai.com/api/docs/guides/speech-to-text
