# Kneut tijdens de vergadering

Start de vergadering. Kneut gebruikt de bestaande live tekst en spreekt pas als de app hem het woord geeft. Een aparte agent aanmaken is niet nodig.

- Zeg **Kneut, welke afspraken hebben we gemaakt?**. Alleen **Kneut?** geeft een zichtbaar luistersignaal en na de pauze een kort antwoord. Een vermelding zoals **Dat kan Kneut straks opschrijven** activeert hem niet. De aanspreekvorm moet aan het begin van een getranscribeerde spreekbeurt staan; `Hey Kneut` mag ook. De gespreksknop blijft beschikbaar bij gemiste herkenning.
- Zeg **Kneut, bewaar je vragen tot het einde**, of gebruik de gelijknamige knop. Directe vragen blijven mogelijk. Met de knop kunnen vragen bij overgangen weer worden toegestaan.
- Zeg **Kneut, wat staat er nog open?** om de bestaande lijst te horen. Na afronden staat die lijst in beeld en kan **Bespreek open vragen na afloop** haar voorlezen. Voor een vervolggesprek gebruik je **Praat met de notulist**.

## Wanneer hij zelf iets vraagt

Een serverbeoordeling houdt hoogstens acht belangrijke vragen bij: onduidelijke besluiten, ontbrekende actiehouders en tegenstrijdige afspraken. Losse ideeën of een ontbrekende niet-noodzakelijke deadline zijn geen reden om in te grijpen. Vragen die later vanzelf worden beantwoord verdwijnen. Nieuwe vragen moeten een letterlijk citaat uit de recente bron bevatten. De lijst is een AI-beoordeling en blijft controleerbaar in beeld.

Een spontane vraag vereist tegelijk:

1. De beoordeling hoort exact bij de huidige afgeronde live tekst.
2. Het laatste deel is volgens de beoordeling een duidelijke overgang; ook een conservatieve tekstcontrole moet een afronding plus overgang herkennen, bijvoorbeeld **Akkoord, volgende punt**.
3. Minimaal drie seconden geen gedetecteerde spraak, recente microfoonframes en geen nog te verwerken transcriptiebeurt.
4. Geen handmatig gesprek, antwoord, uitstelstand of eerdere vraag in de afgelopen twee minuten.
5. Dezelfde vraag is in deze sessie nog niet gesteld.

Deze voorwaarden worden opnieuw gecontroleerd na het verbinden, vóór het antwoord wordt aangevraagd. Begint iemand tijdens het antwoord te spreken, dan wordt playback lokaal gedempt en wordt het serverantwoord geannuleerd, ook als het nog niet is begonnen. Een denkpauze zonder overgang is nooit voldoende. Bij twijfel blijft de vraag in beeld. De stille bewaking opent geen doorlopende spraakverbinding: pas een aanspreking of toegestane vraag opent het bestaande overleg met een gedempte microfoonclone en automatische antwoorden uit. De handmatige gespreksknop schakelt de gewone gesproken dialoog in.

Direct aanspreken wacht circa 1,8 seconde na de laatste spraak en op complete live tekst. Dit is geen lokale wake-word engine: internet en geslaagde transcriptie zijn nodig. Er is geen sprekerherkenning toegevoegd.

## Bewaren en grenzen

De beoordeling verwerkt hoogstens de laatste 28.000 tekens, met de bestaande open vragen als context. Zij draait bij gewijzigde afgeronde tekst maximaal eens per twaalf seconden per client; de server begrenst aanvragen tot eens per tien seconden, gebruikt een verwerkingslease en hergebruikt dezelfde tekst. Dit verbruikt aanvullend OpenAI-budget. Bij storingen blijven de opname en handmatige bediening onafhankelijk werken. Offline of gepauzeerd zijn spontane vragen uitgeschakeld; oude aanspreekvormen worden niet alsnog afgespeeld.

Vragen worden server-side onder de eigen vergadering opgeslagen; browsertoegang tot deze subcollectie blijft geweigerd. Alleen het bestaande toegestane account mag de callable gebruiken. De uitstelstand, reeds gestelde vragen en laatste interventietijd worden per vergadering lokaal bewaard. Bij herstel is de getoonde lijst de laatst bekende stand; een nieuwe tekstbeoordeling werkt haar bij. Definitieve notulen controleren de serverlijst opnieuw tegen de volledige verwerkte transcriptie en nemen resterende onzekerheden op.

De bespreekknop na afronden leest vragen voor; hij verandert de al afgeronde opname of notulen niet. Nieuwe antwoorden moeten in de vergadering worden opgenomen en opnieuw verwerkt, of bestaande actiepunten kunnen via het bevestigde wijzigingsvoorstel worden aangepast.

Echocancellatie helpt, maar de AI-stem uit een tabletspeaker kan bij een ongunstige opstelling opnieuw worden gehoord en Kneut onbedoeld stoppen of in de tekst verschijnen. Test de echte tablet, afstand en geluidssterkte met meerdere deelnemers; oortjes zijn geschikt voor de eerste test. Onderbrekingen voorkomen is een conservatieve afweging, geen garantie dat software het einde van een groepsdiscussie altijd begrijpt. Standaard worden liever te weinig vragen uitgesproken. Browser- en achtergrondbeperkingen blijven gelden.

## Verificatie

De geautomatiseerde tests gebruiken gemockte AI-antwoorden en controleren rechtstreeks aanspreken, vermeldingen, denkpauzes, spontaan opgeloste vragen, verouderde beoordelingen, cooldown, uitstellen, offline/pauze, spraak tijdens verbinden en annuleren vóór playback. Componenttests controleren de aansluiting op de bediening. Een volledige proef in een echte browser blijft nodig; in deze werkomgeving kon Chromium niet worden geïnstalleerd. De tests bewijzen de regels en aansluiting; naamherkenning en de inhoudelijke beoordeling vereisen een echte Nederlandstalige proefvergadering.

OpenAI-documentatie: https://developers.openai.com/api/reference/resources/realtime/client-events (handmatige response-trigger, Semantic VAD en cancellation).
