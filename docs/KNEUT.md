# Kneut tijdens de vergadering

Start de vergadering. Kneut gebruikt de bestaande live tekst en spreekt pas als de app hem het woord geeft. Een aparte agent aanmaken is niet nodig.

- Zeg **Kneut, welke afspraken hebben we gemaakt?**. De live transcriptieverbinding sluit en **Praat met de notulist** start automatisch als gewone gesproken dialoog. De al uitgesproken vraag wordt meegenomen, zonder herhalen. Alleen **Kneut?** opent het gesprek met een korte bevestiging; je kunt daarna verder praten zonder zijn naam opnieuw te zeggen. De lokale opname blijft doorlopen. Een vermelding zoals **Dat kan Kneut straks opschrijven** activeert hem niet. De aanspreekvorm moet aan het begin van een getranscribeerde spreekbeurt staan; `Hey Kneut` mag ook. De gespreksknop blijft beschikbaar bij gemiste herkenning.
- Kies **Terug naar meeluisteren** om het overleg af te sluiten. Als de vergadering nog wordt opgenomen, hervat de live transcriptie en wordt opgeslagen audio bijgewerkt. Ook bij een fout of het einde van de vijfminutensessie keert de app terug naar meeluisteren. Bij een gepauzeerde/afgeronde opname start geen transcriptieverbinding. Ingehaalde aanspreekvormen worden niet opnieuw uitgevoerd.
- Zeg **Kneut, bewaar je vragen tot het einde**, of gebruik de gelijknamige knop. Directe vragen blijven mogelijk. Met de knop kunnen vragen bij overgangen weer worden toegestaan.
- Zeg **Kneut, wat staat er nog open?** om de bestaande lijst te horen. Na afronden staat die lijst in beeld en kan **Bespreek open vragen na afloop** haar voorlezen. De bespreekknop opent dezelfde gespreksstand, zodat je direct kunt doorvragen.

## Algemene samenvatting en gesprekscontext

**Maak algemene samenvatting** toont onder **Wat is er besproken?** een overzicht van de besproken onderwerpen en standpunten, gevolgd door besluiten, actiepunten en open vragen. Dit werkt ook zonder definitieve notulen. **Samenvatting bijwerken** verwerkt nieuwere tekst; de app meldt wanneer het zichtbare overzicht verouderd is. Live tekst krijgt een voorlopigheidsmelding. De samenvatting wordt lokaal bij de vergadering bewaard en meegenomen in de tekstback-up.

Vóór een gesprek, zowel via Kneut als via de knop, maakt de app deze samenvatting automatisch actueel. Eerst sluit de live transcriptieverbinding; de opname blijft werken. De app toont de voortgang en biedt annuleren. De samenvatting gaat samen met recente letterlijke tekst, bestaande notulen en open vragen naar het spraakgesprek. De AI wordt geïnstrueerd ontbrekende of onzekere informatie als zodanig te benoemen. Samenvatten kan details verliezen; dit vervangt de volledige bron of definitieve notulen niet.

Alle beschikbare afgeronde tekst van de vergadering wordt verwerkt, inclusief oudere passages buiten de recente gesprekscontext. Nog onvoltooide live zinnen tellen niet mee. Lange tekst wordt achtereenvolgens in delen van maximaal 24.000 tekens samengevat, waarbij ieder deel de vorige samenvatting bijwerkt. De limiet is 40 delen; daarboven verschijnt een fout in plaats van stilzwijgend tekst af te kappen. Dit is een samenvatting op verzoek, geen continu bijgewerkt langetermijngeheugen. De bestaande limiet voor definitieve notulen blijft ongewijzigd.

De callable `summarizeVoiceContext` controleert het toegestane account en bewaart resultaatdelen onder de eigen vergadering in `voiceBriefings`. Directe browsertoegang blijft standaard geweigerd. Een bronhash, volgordecontrole en verwerkingslease voorkomen conflicterende of dubbel uitgevoerde aanvragen. Hergebruik van dezelfde afgeronde bron gebruikt de bestaande samenvatting. Nieuwe bronversies vragen een nieuwe ronde en verbruiken extra OpenAI-budget. Annuleren stopt volgende delen en het starten van het gesprek; een al verstuurd serververzoek kan nog afronden. Bij een fout hervat het meeluisteren en kan de gebruiker opnieuw proberen.

## Wanneer hij zelf iets vraagt

Een serverbeoordeling houdt hoogstens acht belangrijke vragen bij: onduidelijke besluiten, ontbrekende actiehouders en tegenstrijdige afspraken. Losse ideeën of een ontbrekende niet-noodzakelijke deadline zijn geen reden om in te grijpen. Vragen die later vanzelf worden beantwoord verdwijnen. Nieuwe vragen moeten een letterlijk citaat uit de recente bron bevatten. De lijst is een AI-beoordeling en blijft controleerbaar in beeld.

Een spontane vraag vereist tegelijk:

1. De beoordeling hoort exact bij de huidige afgeronde live tekst.
2. Het laatste deel is volgens de beoordeling een duidelijke overgang; ook een conservatieve tekstcontrole moet een afronding plus overgang herkennen, bijvoorbeeld **Akkoord, volgende punt**.
3. Minimaal drie seconden geen gedetecteerde spraak, recente microfoonframes en geen nog te verwerken transcriptiebeurt.
4. Geen handmatig gesprek, antwoord, uitstelstand of eerdere vraag in de afgelopen twee minuten.
5. Dezelfde vraag is in deze sessie nog niet gesteld.

Deze voorwaarden worden opnieuw gecontroleerd na het verbinden, vóór het antwoord wordt aangevraagd. Begint iemand tijdens het antwoord te spreken, dan wordt playback lokaal gedempt en wordt het serverantwoord geannuleerd, ook als het nog niet is begonnen. Een denkpauze zonder overgang is nooit voldoende. Bij twijfel blijft de vraag in beeld. De stille bewaking opent geen doorlopende spraakverbinding. Alleen een spontane verduidelijkingsvraag gebruikt de gecontroleerde spraakstand met gedempte microfoonclone en automatische antwoorden uit. Aanspreken met Kneut en de gespreksknop openen de gewone gesproken dialoog met ingeschakelde microfoonclone. Daarbij wordt de live transcriptieverbinding gesloten; de recorder blijft onafhankelijk werken.

Direct aanspreken wacht circa 1,8 seconde na de laatste spraak en op complete live tekst. Dit is geen lokale wake-word engine: internet en geslaagde transcriptie zijn nodig. Er is geen sprekerherkenning toegevoegd.

## Bewaren en grenzen

De beoordeling verwerkt hoogstens de laatste 28.000 tekens, met de bestaande open vragen als context. Zij draait bij gewijzigde afgeronde tekst maximaal eens per twaalf seconden per client; de server begrenst aanvragen tot eens per tien seconden, gebruikt een verwerkingslease en hergebruikt dezelfde tekst. Dit verbruikt aanvullend OpenAI-budget. Bij storingen blijven de opname en handmatige bediening onafhankelijk werken. Offline of gepauzeerd zijn spontane vragen uitgeschakeld; oude aanspreekvormen worden niet alsnog afgespeeld.

Vragen worden server-side onder de eigen vergadering opgeslagen; browsertoegang tot deze subcollectie blijft geweigerd. Alleen het bestaande toegestane account mag de callable gebruiken. De uitstelstand, reeds gestelde vragen en laatste interventietijd worden per vergadering lokaal bewaard. Bij herstel is de getoonde lijst de laatst bekende stand; een nieuwe tekstbeoordeling werkt haar bij. Definitieve notulen controleren de serverlijst opnieuw tegen de volledige verwerkte transcriptie en nemen resterende onzekerheden op.

De bespreekknop na afronden opent een gesprek over de vragen; hij verandert de al afgeronde opname of notulen niet. Nieuwe antwoorden moeten in de vergadering worden opgenomen en opnieuw verwerkt, of bestaande actiepunten kunnen via het bevestigde wijzigingsvoorstel worden aangepast.

Echocancellatie helpt, maar de AI-stem uit een tabletspeaker kan bij een ongunstige opstelling opnieuw worden gehoord en Kneut onbedoeld stoppen of in de tekst verschijnen. Test de echte tablet, afstand en geluidssterkte met meerdere deelnemers; oortjes zijn geschikt voor de eerste test. Onderbrekingen voorkomen is een conservatieve afweging, geen garantie dat software het einde van een groepsdiscussie altijd begrijpt. Standaard worden liever te weinig vragen uitgesproken. Browser- en achtergrondbeperkingen blijven gelden.

## Verificatie

De geautomatiseerde tests gebruiken gemockte AI-antwoorden en controleren rechtstreeks aanspreken, vermeldingen, denkpauzes, spontaan opgeloste vragen, verouderde beoordelingen, cooldown, uitstellen, offline/pauze, spraak tijdens verbinden en annuleren vóór playback. Componenttests controleren de aansluiting op de bediening, de zichtbare algemene samenvatting, hergebruik als gesprekscontext en annuleren vóór het gesprek. Client- en servertests controleren lange bronnen, deelvolgorde, caching, toegangscontrole en mislukte antwoorden. Een headless browserproef gebruikt een synthetische microfoon en gemockte transcriptie-/Realtime-dienst voor de schakelbediening en de API-berichten. Dit vervangt geen echte OpenAI- en herkenningsproef. De tests bewijzen de regels en aansluiting; naamherkenning en de inhoudelijke beoordeling vereisen een echte Nederlandstalige proefvergadering.

OpenAI-documentatie: https://developers.openai.com/api/reference/resources/realtime/client-events (handmatige response-trigger, Semantic VAD en cancellation).


Bij spraakfouten toont alleen de foutmelding rood. Uitklapbare technische gegevens bevatten een foutcode, een veldnaam en het type verzoek wanneer beschikbaar, zonder de ruwe fouttekst of vergaderinhoud. Interne spreekinstructies verschijnen niet als gebruikersberichten. Nieuwe antwoorden wachten bij onderbreken op het einde van de vorige response; client-itemcodes zijn maximaal 32 tekens.
