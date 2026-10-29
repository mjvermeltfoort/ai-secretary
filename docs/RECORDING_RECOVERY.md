# Opname en verbindingsherstel voor lange vergaderingen

Dit is de eerste stap van het plan voor drie uur vergaderen, met vier uur als ontwerpmarge. De app bewaart audio onafhankelijk van OpenAI en kan live tekst opnieuw opbouwen vanuit die lokale bron. Het doorlopende vergadergeheugen en het opdelen van lange definitieve notulen komen in volgende stappen; de bestaande grens van 120.000 tekens bij definitieve verwerking is in deze PR niet opgeheven.

## Bediening

- Start een vergadering. De app controleert de geschatte beschikbare opslag en vraagt waar mogelijk om blijvende browseropslag. Vier uur mono PCM vraagt ongeveer 691 MB audio; de controle rekent circa 849 MB inclusief reserve. Bij te weinig ruimte kan de gebruiker ruimte vrijmaken of bewust toch starten. Tijdens opname wordt de ruimte elke minuut opnieuw gecontroleerd, met een waarschuwing bij minder dan circa vijftien minuten plus reserve.
- Waar ondersteund vraagt de app een scherm-wakkerhoudslot. Dit wordt na terugkeren naar een zichtbare pagina opnieuw aangevraagd en bij pauzeren, afronden of sluiten vrijgegeven. Laat de app zichtbaar, voorkom vergrendelen en gebruik stroom. Een wake lock is geen garantie tegen browser- of OS-suspensie.
- Bij verbindingsverlies blijft de opname lopen. De live tekst toont verbinding/herstel/inhalen afzonderlijk. Verbinden wordt opnieuw geprobeerd met oplopende wachttijd tot ongeveer dertig seconden plus jitter. De knop **Live tekst herstellen** kan ook handmatig opnieuw beginnen.
- Na herladen worden opgeslagen tekst, laatst gegenereerde notulen en de bijbehorende opname teruggehaald. **Hervat vergadering** voegt nieuwe audio toe aan dezelfde vergadering; de onderbreking zelf is uiteraard niet opgenomen. Microfoontoegang wordt opnieuw aangevraagd, niet automatisch aangezet na een herlaadactie.
- Bij een onverwacht beëindigde microfoon of gesuspendeerde audiocontext meldt de app een onderbreking en sluit zij de recorder gecontroleerd af. Hervatten vereist een bewuste klik.
- Na stoppen/herstellen biedt **Download opname** één WAV-bestand aan. In browsers met een bestandskiezer wordt per audioblok naar het gekozen bestand geschreven. Andere browsers krijgen een gewone download uit Blob-delen. **Download tekstback-up** bewaart de huidige tekst en notulen als JSON. Controleer dat een aangeboden download daadwerkelijk op het apparaat staat. Export verwijdert geen bronbestanden. Pauzes zijn niet opgenomen en worden in de WAV niet met stilte opgevuld.

## De lokale bron bepaalt de voortgang

De recorder blijft één AudioWorklet gebruiken en schrijft zelfstandig afspeelbare WAV-blokken, gewoonlijk iedere twee seconden. Nieuwe blokken krijgen een SHA-256-controlecode. Recorderwrites voegen blokken toe met `add`: een bestaand blok wordt niet stilzwijgend overschreven, ook niet als twee tabbladen dezelfde sessie proberen op te nemen. Normale metadata-updates van oudere code blijven ondersteund.

De live verbinding leest uitsluitend reeds opgeslagen blokken. Zij decodeert per blok, streamt frames van ongeveer 100 ms en gebruikt nog steeds natuurlijke spraakpauzes voor commits, met een technische bovengrens van ongeveer zestig seconden per beurt. Dit voegt circa de opslagblokduur aan aanvoerlatentie toe. Audio die nog niet lokaal vastligt wordt niet als herstelbaar voorgesteld.

Slechts één gecommitteerde beurt tegelijk wacht op een definitief resultaat. Per beurt zijn audio-start, audio-einde en een stabiel volgnummer bekend. Tekst en bevestigde samplepositie worden samen in één IndexedDB-transactie opgeslagen, vóór de beurt als afgerond wordt gepubliceerd. Een nieuwe verbinding begint bij die samplepositie. Een onbevestigde beurt kan opnieuw naar de dienst gaan, maar vervangt dezelfde voorlopige tekstregel. Zo is netwerkverwerking minstens eenmaal, terwijl de bevestigde tekst één keer wordt gepubliceerd. Dit garandeert geen identieke herkenningswoorden bij een herhaling.

Transportbuffers zijn begrensd; bij terugdruk wacht de zender en blijft de bron op schijf. Bij een vastgelopen verbinding wordt opnieuw verbonden. Een mislukte lokale lees- of checkpointwrite wordt zichtbaar gemeld en vraagt om handmatig herstellen/controle na afloop. Er wordt dan geen volledig herstel geclaimd. Nieuwe blokken en export controleren formaat en, waar aanwezig, de controlecode. Oudere WAV-blokken zonder controlecode blijven leesbaar. Oudere WebM/MP4-opnamen blijven voor de bestaande verwerking na afloop beschikbaar, maar kunnen niet via deze nieuwe live WAV-route worden hervat of als één WAV worden geëxporteerd.

## Vernieuwen en Kneut

De app vernieuwt de transcriptieverbinding volgens eigen beleid ongeveer iedere twintig minuten. Bij actieve spraak wacht zij tot de lopende beurt is bevestigd en daarna kort tot rust, zodat een verse aanspreking eerst verwerkt kan worden. De recorder wordt niet herstart. Een bevestigingstermijn en verbindings-timeout voorkomen onbeperkt wachten op een dood transport.

Bij opnieuw verbinden en het inhalen van opgeslagen audio staat Kneut stil. Teruggehaalde tekst krijgt een herstelmarkering; aanspreekvormen uit die tekst worden niet achteraf uitgevoerd. Ook oude onderwerpsovergangen veroorzaken geen spontane vraag. Nieuwe actuele tekst moet eerst weer beschikbaar zijn. De handmatige gespreksknop blijft beschikbaar. Opnieuw aangeboden audio kan opnieuw OpenAI-budget gebruiken; automatische herverbinding is geen harde financiële limiet.

## Herstelgegevens en grenzen

De bestaande IndexedDB wordt van versie 1 naar 2 uitgebreid, zonder audiobestanden te verwijderen. Een aparte recovery-store bewaart live tekst plus cursor, en los daarvan de laatst verwerkte transcriptie en notulen. Updates van deze onderdelen worden transactioneel samengevoegd. Bij een database-upgrade kan een oud tabblad moeten worden gesloten. Lokale brondata, tekst en notulen blijven binnen hetzelfde browserprofiel; dit is geen externe back-up en geen bescherming tegen het wissen van browsergegevens.

Stoppen en pauzeren sluiten de microfoon eerst af en geven de live verbinding hoogstens kort tijd om af te ronden. Een nog onbevestigd einde blijft uit de lokale bron herstelbaar. Definitieve audioverwerking blijft de bestaande aparte controle gebruiken. De servercache van die controle blijft bruikbaar bij opnieuw proberen; live herstel betekent niet dat lange notulen al gereed zijn.

Een crash kan het nog niet opgeslagen laatste blok en eventuele wachtende schrijfbewerkingen verliezen. Een quota-inschatting is geen reservering. De volledige hardware-/browserproef van drie uur volgt pas na de volgende onderdelen van het plan.

## Validatie in deze PR

- Recorder met gesimuleerde Web Audio: samplebehoud, checksum, onafhankelijkheid van een defecte AI-consument, dezelfde audiograaf bij pauze/hervatten, hervatten na stoppen en microfoon-/contextonderbreking.
- Live transport met echte PCM/WAV-testblokken en gemockte OpenAI: natuurlijke pauzes, replay zonder dubbele bevestigde tekst, late resultaten, afgebroken en vertraagde checkpointwrites, verbindingswissels, backoff, annulering, bronfouten en vier uur **virtuele kloktijd** met korte audiostroken.
- IndexedDB via fake-indexeddb: migratie van bestaande bestanden, transactioneel samenvoegen en weigeren van overschrijven.
- Export: exacte samengevoegde samples, controlesommen, afbreken van schrijffouten, vieruurs-WAV-header en drie uur aan segmentverwijzingen (5400 blokken, hergebruikte test-Blob) met writes van maximaal 96 kB. Dit is geen drie uur durende apparaatopname.
- React-bediening en wake-lock-/opslagtests.
- Headless Chromium met echte AudioWorklet, Web Audio en native IndexedDB, een synthetische microfoon en gemockte AI-verzoeken: opname, automatische herverbinding, herladen met bewaarde tekst, hervatten van dezelfde vergadering en een geldige WAV-download. Desktop en 390px mobiel gecontroleerd op layout/overflow.
- Geen betaalde OpenAI-calls en geen claim van een uitgevoerde echte drie-uursvergadering.

OpenAI-documentatie voor het ongewijzigde append/commit-protocol en de transcriptie-events: https://developers.openai.com/api/docs/guides/realtime-transcription
