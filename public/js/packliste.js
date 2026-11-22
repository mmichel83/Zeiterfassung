/*
 * Packliste aus einer Aufgabenbeschreibung.
 *
 * Erkennt Arbeiten, Farbarten und Orte („Innenanstrich einer Whg mit Silikatfarbe“)
 * und stellt zusammen, was mitmuss. Läuft im Browser (global PACK) und in Node.
 * Das Ergebnis ist ein Vorschlag: Das Büro kann jede Zeile ändern.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PACK = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SECTIONS = ['Vorher klären', 'Schutzausrüstung', 'Abdecken und Schützen', 'Werkzeug', 'Material', 'Vor Ort'];
  const [KLAEREN, SCHUTZ, ABDECKEN, WERKZEUG, MATERIAL, VORORT] = SECTIONS;

  /**
   * Bausteine. when(t, has) entscheidet, ob ein Baustein passt:
   * t ist die kleingeschriebene Beschreibung, has die schon erkannten Bausteine.
   */
  const BLOCKS = [
    {
      id: 'innen', label: 'Innenräume',
      when: (t) => /innen|wohnung|\bwhg\b|zimmer|küche|kueche|\bbad\b|badezimmer|\bflur|diele|treppenhaus|büro|buero|\braum|räume|raeume|\bdecke\b|\bdecken\b|\bwände\b|\bwand\b|keller|praxis|laden|wohnhaus/.test(t),
      items: {
        [ABDECKEN]: ['Abdeckfolie', 'Malervlies oder Abdeckpapier für den Boden', 'Kreppband', 'Abdeckmaschine', 'Abdeckband mit Folie', 'Türschutz und Kantenschutz'],
        [VORORT]: ['Laufweg mit Malervlies ausgelegt', 'Möbel abgerückt und abgedeckt', 'Schalter und Steckdosen abgeklebt oder abgeschraubt', 'Rauchmelder abgedeckt und abends wieder frei'],
      },
    },
    {
      id: 'bewohnt', label: 'Wohnung',
      when: (t) => /wohnung|\bwhg\b|bewohnt|einfamilienhaus|zimmer|wohnhaus/.test(t),
      items: {
        [KLAEREN]: ['Termin und Schlüssel mit dem Kunden abgesprochen', 'Parken und Strom geklärt'],
      },
    },
    {
      id: 'treppenhaus', label: 'Treppenhaus',
      when: (t) => /treppenhaus|treppe|hausflur|stiegenhaus/.test(t),
      items: {
        [KLAEREN]: ['Hausbewohner per Aushang informiert'],
        [ABDECKEN]: ['Handlauf und Geländer abgeklebt', 'Rutschfestes Malervlies für die Stufen'],
        [WERKZEUG]: ['Leiter, die auf Treppen sicher steht, oder Treppenpodest'],
        [VORORT]: ['Treppe bleibt begehbar', 'Schild „Frisch gestrichen“'],
      },
    },
    {
      id: 'anstrich', label: 'Anstrich',
      when: (t) => /anstrich|streich|gestrichen|farbe|silikat|dispersion|latex|kalkfarbe|renovier|weißel|weissel|weißen|malerarbeit|\bmalen\b|beschicht|lasur/.test(t),
      items: {
        [WERKZEUG]: ['Farbrollen', 'Ersatzrollen', 'Abstreifgitter', 'Farbeimer oder Farbwanne', 'Flachpinsel und Ringpinsel', 'Rührstab oder Rührwerk'],
        [MATERIAL]: ['Acryl', 'Acrylspritze'],
      },
    },
    {
      id: 'anstrich-innen', label: '',
      when: (t, has) => has.has('anstrich') && has.has('innen'),
      items: {
        [WERKZEUG]: ['Kleine Rollen für Ecken und hinter Heizkörpern', 'Teleskopstange', 'Spachtel und Japanspachtel', 'Schleifpapier und Handschleifer'],
        [MATERIAL]: ['Reparaturspachtel für Löcher'],
        [VORORT]: ['Untergrund geprüft: tragfähig, sauber, trocken', 'Farbton mit dem Kunden abgestimmt'],
      },
    },
    {
      id: 'decke', label: 'Decke',
      when: (t) => /\bdecken?\b|deckenanstrich|deckenfarbe/.test(t),
      items: {
        [WERKZEUG]: ['Deckenrolle mit Teleskopstange', 'Podest oder Rollgerüst für hohe Decken'],
        [SCHUTZ]: ['Schutzbrille gegen Farbspritzer von oben'],
      },
    },
    {
      id: 'altbau', label: 'Altbau',
      when: (t) => /altbau|leimfarbe|stuck/.test(t),
      items: {
        [KLAEREN]: ['Wischprobe an der Decke: Leimfarbe muss vorher abgewaschen werden'],
        [WERKZEUG]: ['Rollgerüst für hohe Räume', 'Schwamm und Bürste zum Abwaschen'],
        [MATERIAL]: ['Tiefgrund'],
      },
    },
    {
      id: 'silikat', label: 'Silikatfarbe',
      when: (t) => /silikat|sylitol|keim\b|fixativ/.test(t),
      items: {
        [KLAEREN]: ['Untergrund mineralisch oder für Silikat geeignet, alte Dispersionsanstriche geprüft', 'Raum und Untergrund nicht unter +8 °C, Herstellerangabe prüfen'],
        [SCHUTZ]: ['Schutzbrille, Silikatfarbe ist alkalisch', 'Nitrilhandschuhe', 'Augenspülflasche'],
        [ABDECKEN]: ['Glas, Fliesen, Naturstein, Klinker, Metall und Lack besonders gut abdecken, Silikat greift sie an'],
        [WERKZEUG]: ['Eimer mit klarem Wasser und Schwamm, um Spritzer sofort abzuwaschen', 'Rollen und Pinsel nur für Silikat, ohne Reste anderer Farben'],
        [MATERIAL]: ['Silikatfarbe: Menge und Farbton laut Auftrag', 'Silikat-Grundierung oder Fixativ zum Grundieren und Verdünnen', 'Spachtelmasse, die für Silikatfarbe geeignet ist'],
        [VORORT]: ['Flächen nass in nass ohne Pause durchstreichen, damit keine Ansätze bleiben', 'Werkzeug gleich nach der Arbeit mit Wasser reinigen'],
      },
    },
    {
      id: 'kalk', label: 'Kalkfarbe',
      when: (t) => /kalkfarbe|kalkanstrich|sumpfkalk|\bkalk\b/.test(t),
      items: {
        [KLAEREN]: ['Untergrund mineralisch, Mindesttemperatur laut Hersteller'],
        [SCHUTZ]: ['Schutzbrille, Kalk ist ätzend', 'Nitrilhandschuhe', 'Augenspülflasche'],
        [ABDECKEN]: ['Glas, Fliesen und Metall besonders gut abdecken'],
        [WERKZEUG]: ['Kalkbürste oder breiter Pinsel', 'Eimer mit klarem Wasser und Schwamm für Spritzer'],
        [MATERIAL]: ['Kalkfarbe: Menge und Farbton laut Auftrag', 'Grundierung laut Hersteller'],
        [VORORT]: ['Untergrund vornässen, wenn der Hersteller es verlangt'],
      },
    },
    {
      id: 'latex', label: 'Latexfarbe',
      when: (t) => /latex/.test(t),
      items: {
        [WERKZEUG]: ['Kurzflorrollen für Latex'],
        [MATERIAL]: ['Latexfarbe: Menge, Farbton und Glanzgrad laut Auftrag', 'Grundierung'],
        [VORORT]: ['Ganze Wandflächen ohne Pause streichen, sonst glänzen die Ansätze'],
      },
    },
    {
      id: 'dispersion', label: 'Dispersionsfarbe',
      when: (t) => /dispersion/.test(t),
      items: {
        [MATERIAL]: ['Dispersionsfarbe: Menge und Farbton laut Auftrag', 'Tiefgrund oder Grundierung'],
      },
    },
    {
      id: 'wandfarbe', label: '',
      // Innenanstrich ohne genannte Farbart: normale Wandfarbe
      when: (t, has) => has.has('anstrich-innen') && !['silikat', 'kalk', 'latex', 'dispersion'].some((x) => has.has(x)),
      items: {
        [MATERIAL]: ['Wandfarbe: Menge und Farbton laut Auftrag', 'Tiefgrund oder Grundierung'],
      },
    },
    {
      id: 'deckenfarbe', label: '',
      when: (t, has) => has.has('decke') && has.has('anstrich'),
      items: { [MATERIAL]: ['Deckenfarbe'] },
    },
    {
      id: 'airless', label: 'Spritzen',
      when: (t) => /airless|spritz|sprüh|spruh/.test(t),
      items: {
        [SCHUTZ]: ['Spritzschutzanzug', 'Atemschutz gegen Farbnebel'],
        [ABDECKEN]: ['Alles im Raum großzügig abdecken, auch gegen Sprühnebel'],
        [WERKZEUG]: ['Airless-Gerät', 'Farbschlauch und Spritzpistole', 'Düsen in passender Größe', 'Ersatzfilter', 'Eimer und Reiniger zum Durchspülen'],
      },
    },
    {
      id: 'tapete', label: 'Tapezieren',
      when: (t) => /tapez|tapete|raufaser|makulatur|vlies(tapete)?\b|glasgewebe|glasfaser/.test(t),
      items: {
        [WERKZEUG]: ['Tapeziertisch', 'Kleistereimer und Quast oder Kleistergerät', 'Tapezierbürste und Andrückrolle', 'Nahtroller', 'Tapezierschere', 'Cutter mit vielen Ersatzklingen', 'Andrückspachtel', 'Wasserwaage oder Lot', 'Schwamm und Eimer mit klarem Wasser'],
        [MATERIAL]: ['Tapete: alle Rollen mit derselben Anfertigungsnummer', 'Ein paar Rollen Reserve', 'Kleister passend zur Tapete', 'Grundierung oder Makulatur'],
        [VORORT]: ['Strom an Schaltern und Steckdosen aus, Abdeckungen abgenommen', 'Erste Bahn mit dem Kunden abgestimmt'],
      },
    },
    {
      id: 'vlies', label: 'Vliestapete',
      when: (t) => /vlies(tapete)?\b|vliestapete/.test(t) && !/malervlies/.test(t),
      items: {
        [WERKZEUG]: ['Kleisterrolle für die Wandklebetechnik'],
        [MATERIAL]: ['Kleister für Vliestapete'],
      },
    },
    {
      id: 'glasgewebe', label: 'Glasgewebe',
      when: (t) => /glasgewebe|glasfaser/.test(t),
      items: {
        [SCHUTZ]: ['Langärmlige Kleidung und Handschuhe gegen Glasfasern'],
        [MATERIAL]: ['Spezialkleber für Glasgewebe'],
      },
    },
    {
      id: 'alttapete', label: 'Alte Tapete runter',
      when: (t) => /(alte|alten|entfern|ablös|abloes|abreiß|abreiss|runter).{0,25}tapete|tapete.{0,25}(entfern|ablös|abloes|runter|abreiß|abreiss)|ablösen|abloesen/.test(t),
      items: {
        [WERKZEUG]: ['Tapetenablöser', 'Stachelwalze', 'Breiter Spachtel', 'Dampfgerät, wenn sie schlecht abgeht'],
        [MATERIAL]: ['Viele Müllsäcke'],
      },
    },
    {
      id: 'lack', label: 'Lackieren',
      when: (t) => /lack|heizkörper|heizkoerper|zarge|türblatt|tür(en)? (streichen|lackieren)|fenster(rahmen)? (streichen|lackieren)|fensterrahmen|geländer|gelaender|handlauf/.test(t),
      items: {
        [SCHUTZ]: ['Atemschutz mit Gasfilter bei lösemittelhaltigem Lack'],
        [ABDECKEN]: ['Abklebeband für saubere Kanten'],
        [WERKZEUG]: ['Anlauger oder Reiniger', 'Schleifpapier, Körnung 120 bis 240', 'Schleifklotz und Schleifvlies', 'Staubbindetuch', 'Lackrollen mit Bügel', 'Lackpinsel in verschiedenen Breiten', 'Lackwanne'],
        [MATERIAL]: ['Vorlack oder Grundierung', 'Lack: Farbton und Glanzgrad laut Auftrag', 'Verdünnung oder Reiniger passend zum Lack', 'Feinspachtel oder Holzkitt'],
        [VORORT]: ['Lüften möglich', 'Schild „Frisch gestrichen“'],
      },
    },
    {
      id: 'heizkoerper', label: 'Heizkörper',
      when: (t) => /heizkörper|heizkoerper|radiator/.test(t),
      items: { [WERKZEUG]: ['Heizkörperpinsel', 'Heizkörperrolle'], [MATERIAL]: ['Heizkörperlack'] },
    },
    {
      id: 'tueren', label: 'Türen',
      when: (t) => /tür(en)?\b|zarge|türblatt/.test(t),
      items: { [WERKZEUG]: ['Böcke oder Auflage für ausgehängte Türen', 'Schraubendreher für Beschläge'] },
    },
    {
      id: 'spachtel', label: 'Spachteln',
      when: (t) => /spachtel|\bq[234]\b|trockenbau|gipskarton|rigips|glätten|glaetten|verspachtel/.test(t),
      items: {
        [SCHUTZ]: ['FFP2-Maske beim Schleifen'],
        [WERKZEUG]: ['Flächenspachtel und Glättkelle', 'Japanspachtel und Fugenspachtel', 'Eckenspachtel', 'Rührwerk und Mörtelkübel', 'Langhalsschleifer mit Absaugung', 'Schleifgitter und Schleifpapier', 'Streiflichtlampe zum Prüfen'],
        [MATERIAL]: ['Spachtelmasse', 'Fugendeckstreifen', 'Kantenschutzprofile', 'Grundierung'],
      },
    },
    {
      id: 'risse', label: 'Risse',
      when: (t) => /riss/.test(t),
      items: { [MATERIAL]: ['Armierungsvlies oder Gewebe für Risse', 'Acryl für Risse an Anschlüssen'] },
    },
    {
      id: 'flecken', label: 'Flecken',
      when: (t) => /nikotin|raucher|wasserfleck|wasserschaden|ruß|russ\b|rußfleck|verfärb|verfaerb|fleck/.test(t),
      items: {
        [MATERIAL]: ['Isoliergrund oder Sperrgrund gegen Durchschlagen', 'Nikotin- oder Fleckenreiniger'],
        [VORORT]: ['Probestelle: schlägt der Fleck nach dem ersten Anstrich durch?'],
      },
    },
    {
      id: 'schimmel', label: 'Schimmel',
      when: (t) => /schimmel|stockfleck/.test(t),
      items: {
        [SCHUTZ]: ['FFP2- oder FFP3-Maske', 'Einweghandschuhe', 'Einwegschutzanzug'],
        [WERKZEUG]: ['Feuchtemessgerät', 'Einwegtücher', 'Dicht schließende Müllsäcke'],
        [MATERIAL]: ['Schimmelentferner oder Alkohol 70 bis 80 %', 'Fungizide Grundierung', 'Schimmelschutzfarbe'],
        [VORORT]: ['Raum gut gelüftet', 'Ursache besprochen und mit Fotos festgehalten', 'Kunde zu Lüften und Heizen beraten', 'Größerer Befall: mit dem Büro klären, ob ein Fachbetrieb nötig ist'],
      },
    },
    {
      id: 'fassade', label: 'Fassade',
      when: (t) => /fassade|außen(anstrich|wand|wände|putz)?\b|aussen(anstrich|wand|putz)?\b|hauswand|giebel|sockel|wdvs|außenputz/.test(t),
      items: {
        [KLAEREN]: ['Wetter geprüft: kein Regen, Mindesttemperatur laut Hersteller', 'Gerüst geprüft und freigegeben', 'Wasser und Strom vor Ort', 'Nachbarn informiert'],
        [SCHUTZ]: ['Schutzhelm', 'Sonnenschutz und genug Wasser im Sommer'],
        [ABDECKEN]: ['Abdeckfolie für Fenster, Türen und Boden', 'Abdeckmaschine', 'UV-beständiges Abklebeband', 'Abdeckung für Pflanzen, Autos und Gartenmöbel', 'Absperrung und Warnschilder'],
        [WERKZEUG]: ['Hochdruckreiniger mit Schlauch', 'Bürsten', 'Fassadenrollen und Teleskopstange', 'Fassadenpinsel', 'Große Eimer', 'Kelle für Ausbesserungen', 'Kratzer und Drahtbürste'],
        [MATERIAL]: ['Fassadenreiniger oder Algenentferner', 'Fassadenfarbe: Menge und Farbton laut Auftrag', 'Grundierung', 'Reparaturmörtel oder Reparaturspachtel', 'Armierungsgewebe für Risse', 'Acryl für Anschlussfugen'],
      },
    },
    {
      id: 'holz', label: 'Holz außen',
      when: (t) => /holz|lasur|zaun|carport|gartenhaus|pergola|balkon|dachüberstand|dachueberstand|dachuntersicht|fensterläden|klappläden|holzschutz|terrasse/.test(t),
      items: {
        [KLAEREN]: ['Wetter trocken, Holz trocken', 'Mindesttemperatur laut Hersteller'],
        [ABDECKEN]: ['Abdeckfolie für Boden und Pflanzen'],
        [WERKZEUG]: ['Schwingschleifer', 'Drahtbürste und Kratzer für alte Lasur', 'Staubpinsel', 'Lasurpinsel in verschiedenen Breiten'],
        [MATERIAL]: ['Holzreiniger oder Vergrauungsentferner', 'Holzschutzgrund für rohes Holz', 'Lasur oder Holzlack: Farbton laut Auftrag', 'Holzkitt'],
      },
    },
    {
      id: 'boden', label: 'Bodenbeschichtung',
      when: (t) => /boden(beschicht|farbe|anstrich)|bodenbeschichtung|epoxid|epoxy|garagenboden|kellerboden|estrich|betonboden|garage/.test(t),
      items: {
        [KLAEREN]: ['Untergrund trocken, Restfeuchte geprüft', 'Raumtemperatur laut Hersteller', 'Raum für die Trocknungszeit gesperrt'],
        [SCHUTZ]: ['Nitrilhandschuhe', 'Atemschutz laut Sicherheitsdatenblatt', 'Hautschutzcreme'],
        [WERKZEUG]: ['Schleifmaschine oder Fräse mit Absaugung', 'Industriesauger', 'Mischeimer', 'Waage für Zweikomponenten-Material', 'Rollen für Bodenbeschichtung', 'Pinsel für Ränder', 'Stachelschuhe', 'Stachelwalze zum Entlüften'],
        [MATERIAL]: ['Grundierung für den Boden', 'Bodenbeschichtung: Menge und Farbton laut Auftrag', 'Reparaturmörtel für Löcher und Risse', 'Einstreusand, wenn gefordert'],
        [VORORT]: ['Lüften möglich'],
      },
    },
    {
      id: 'hoch', label: 'Höhe',
      when: (t) => /gerüst|geruest|rollgerüst|hoch|halle|hohe/.test(t),
      items: { [WERKZEUG]: ['Rollgerüst oder Podest'] },
    },
    {
      // Grundausstattung, sobald irgendetwas erkannt wurde
      id: 'basis', label: '',
      when: (t, has) => has.size > 0,
      items: {
        [SCHUTZ]: ['Sicherheitsschuhe', 'Arbeitshandschuhe', 'Schutzbrille'],
        [WERKZEUG]: ['Leiter', 'Kabeltrommel', 'Baustrahler', 'Baustaubsauger', 'Eimer', 'Putzlappen', 'Cutter mit Ersatzklingen', 'Zollstock und Bleistift', 'Kreppband', 'Müllsäcke'],
      },
    },
  ];

  /**
   * Schlägt eine Packliste vor.
   * Rückgabe: { body: Text für die Checkliste, found: erkannte Arbeiten, count: Anzahl Punkte }
   */
  function suggest(description) {
    const t = String(description || '').toLowerCase().replace(/\s+/g, ' ');
    const has = new Set();
    const found = [];
    const bySection = new Map(SECTIONS.map((s) => [s, []]));
    const seen = new Set();
    for (const b of BLOCKS) {
      if (!b.when(t, has)) continue;
      has.add(b.id);
      if (b.label) found.push(b.label);
    }
    // Reihenfolge der Bausteine bestimmt die Reihenfolge der Punkte
    for (const b of BLOCKS) {
      if (!has.has(b.id)) continue;
      for (const sec of SECTIONS) {
        for (const item of b.items[sec] || []) {
          // „Schutzbrille, Silikat …“ ersetzt die allgemeine „Schutzbrille“
          const k = item.toLowerCase().split(',')[0].trim();
          if (seen.has(k)) continue;
          seen.add(k);
          bySection.get(sec).push(item);
        }
      }
    }
    const parts = [];
    let count = 0;
    for (const sec of SECTIONS) {
      const list = bySection.get(sec);
      if (!list.length) continue;
      parts.push(`# ${sec}\n${list.join('\n')}`);
      count += list.length;
    }
    return { body: parts.join('\n\n'), found, count };
  }

  return { suggest, SECTIONS };
});
