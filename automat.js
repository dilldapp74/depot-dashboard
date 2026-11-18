// Handelsautomat – Anzeige des Automat-Depots (nur Online-Fassung mit Supabase).
// Gehandelt wird ausschließlich in der Edge Function (Cron); hier wird nur angezeigt und angehalten/fortgesetzt.
// Nutzt die Hilfsfunktionen aus index.html (eur, num, pct, signed, cls, qty, priceFmt, esc, css).

(function () {
  if (API.modus !== 'supabase') return;
  const $ = id => document.getElementById(id);
  let bot = null, chart = null, timer = null;

  const ARTNAME = { kauf: 'Kauf', verkauf: 'Verkauf', stop: 'Stop-Loss', lauf: 'Lauf', pruefung: 'Prüfung', steuer: 'Steuer', fehler: 'Fehler' };
  const STATUSNAME = { offen: 'wartet', frei: 'freigegeben', abgelehnt: 'Veto', demo: 'Demo', ohne: 'ohne Prüfung', fehler: 'Fehler', verfallen: 'verfallen' };
  const zeit = t => new Date(t).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const aktiv = () => document.body.classList.contains('v-bot') && !document.body.classList.contains('abgemeldet');

  // von spiel.js aufgerufen, wenn der Reiter „Automat“ gewählt wird
  window.automatZeigen = () => {
    laden();
    if (!timer) timer = setInterval(() => { if (aktiv()) laden(); }, 60000);
  };
  $('refresh').addEventListener('click', () => { if (aktiv()) laden(); });
  sb.auth.onAuthStateChange((_e, session) => { if (session && aktiv()) setTimeout(laden, 0); });

  async function laden() {
    if (document.body.classList.contains('abgemeldet')) return;
    $('b-stamp').textContent = 'Lade …';
    try { bot = await API.botStatus(); }
    catch (e) { $('b-stamp').textContent = 'Fehler: ' + e.message; return; }
    $('b-leer').hidden = !!bot.depot; $('b-inhalt').hidden = !bot.depot;
    if (bot.depot) zeichnen();
  }

  function zeichnen() {
    const d = bot.depot, k = bot.kosten, start = d.startkapital, pl = bot.gesamt - start;
    $('b-name').textContent = d.name;
    $('b-status').textContent = d.pausiert ? 'angehalten' : 'aktiv';
    $('b-status').className = 'badge ' + (d.pausiert ? 'aus' : 'an');
    $('b-schalter').textContent = d.pausiert ? 'Fortsetzen' : 'Anhalten';
    $('b-stamp').textContent = 'Stand: ' + new Date(bot.generated * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
      + (d.letzter_lauf ? ` · letzter Lauf ${new Date(d.letzter_lauf).toLocaleDateString('de-DE')}` : '');

    const hinweise = [];
    if (d.pausiert) hinweise.push('<b>Angehalten:</b> Der Automat handelt nicht, auch keine Stop-Loss-Verkäufe.');
    if (bot.demo) hinweise.push('<b>Demo-Modus:</b> Käufe werden ohne Claude-Prüfung freigegeben (kein ANTHROPIC_API_KEY in Supabase).');
    if (!hinweise.length) hinweise.push('Handelt selbstständig werktags ab 16:00 – auch wenn Mac und Handy aus sind.');
    $('b-hinweis').innerHTML = hinweise.join('<br>');

    // Kennzahlen
    $('b-total').textContent = eur.format(bot.gesamt);
    $('b-start').textContent = `Start ${eur.format(start)} am ${new Date(d.erstellt).toLocaleDateString('de-DE')}` + (k.krypto_ruecklage ? ' · nach Krypto-Rücklage' : '');
    const e = $('b-pl'); e.textContent = `${signed(pl)} (${pct(pl / start * 100)})`; e.className = 'val ' + cls(pl);
    const vergl = Object.entries({ 'MSCI World': bot.vergleich.welt, 'Bitcoin': bot.vergleich.bitcoin })
      .filter(([, r]) => r?.length).map(([n, r]) => `${n} ${pct((r.at(-1)[1] / start - 1) * 100)}`);
    $('b-vergl').textContent = vergl.length ? 'Zum Vergleich: ' + vergl.join(' · ') : '';
    $('b-kosten').textContent = eur.format(k.gebuehren + k.spread);
    $('b-kosteninfo').textContent = `Gebühren ${eur.format(k.gebuehren)} · Spread ${eur.format(k.spread)} · ${bot.orders.length} Orders`;
    $('b-steuer').textContent = eur.format(k.steuern + k.krypto_ruecklage);
    $('b-steuerinfo').textContent = `Abgeltung gezahlt ${eur.format(k.steuern)} · Krypto-Rücklage ${eur.format(k.krypto_ruecklage)}`
      + (k.realisiert ? ` · realisiert ${signed(k.realisiert)}` : '');

    // Positionen
    $('b-bar').textContent = `· Bargeld ${eur.format(d.bargeld)}`;
    $('b-tbl').tBodies[0].innerHTML = bot.positionen.length ? bot.positionen.map(p => `<tr>
        <td class="name"><div class="n">${esc(p.name || p.kennung)}</div><div class="s">${esc(p.kennung)}${p.fehler ? ' · <span class="err">' + esc(p.fehler) + '</span>' : ''}</div></td>
        <td data-label="Anteile">${qty(p.anteile)}</td>
        <td data-label="Einstand">${priceFmt(p.kosten / p.anteile)}</td>
        <td data-label="Kurs">${p.kurs ? priceFmt(p.kurs) : '–'}</td>
        <td data-label="Wert"><b>${eur.format(p.wert)}</b></td>
        <td data-label="Heute" class="${cls(p.tag_pct)}">${pct(p.tag_pct)}</td>
        <td data-label="G/V" class="${cls(p.pl_abs)}">${signed(p.pl_abs)}<div class="s">${pct(p.pl_pct)}</div></td>
      </tr>`).join('') : '<tr><td colspan="7" class="empty">Noch keine Positionen – der Automat kauft beim nächsten Lauf.</td></tr>';

    // Protokoll, Prüfungen, Orders
    $('b-protokoll').innerHTML = bot.protokoll.length ? bot.protokoll.map(p => `<div class="e">
        <span class="art ${esc(p.art)}">${esc(ARTNAME[p.art] || p.art)}</span> ${esc(p.text)}<div class="s">${zeit(p.zeit)}</div></div>`).join('')
      : '<div class="meta">Noch keine Einträge.</div>';
    $('b-pruefungen').innerHTML = bot.pruefungen.length ? bot.pruefungen.map(p => {
      const u = p.urteil || {}, quellen = (u.quellen || []).filter(q => /^https?:\/\//.test(q.url)).slice(0, 3);
      return `<div class="e"><span class="art ${p.status === 'abgelehnt' ? 'fehler' : p.status === 'offen' ? '' : 'kauf'}">${esc(STATUSNAME[p.status] || p.status)}</span>
        <b>${esc(p.name || p.kennung)}</b>${u.begruendung ? ' – ' + esc(u.begruendung) : ''}
        ${quellen.length ? '<div class="s">' + quellen.map(q => `<a href="${esc(q.url)}" target="_blank" rel="noopener">${esc(q.titel || q.url)}</a>`).join(' · ') + '</div>' : ''}
        <div class="s">${zeit(p.zeit)} · ${esc(p.grund)}${Number(p.kosten_usd) ? ` · ${Number(p.kosten_usd).toFixed(2)} $` : ''}</div></div>`;
    }).join('') : '<div class="meta">Noch keine Prüfungen.</div>';
    $('b-orders').innerHTML = bot.orders.length ? bot.orders.map(o => `<div class="e">
        <b class="${o.seite === 'kauf' ? '' : 'neg'}">${o.seite === 'kauf' ? 'Kauf' : 'Verkauf'} ${qty(o.anteile)} × ${esc(o.name || o.kennung)}</b>
        zu ${priceFmt(o.kurs)} = ${eur.format(o.anteile * o.kurs)}
        ${o.realisiert != null ? ` · Ergebnis <span class="${cls(o.realisiert)}">${signed(Number(o.realisiert))}</span>` : ''}
        ${Number(o.steuer) ? ` · Steuer ${eur.format(Number(o.steuer))}` : ''}
        <div class="s">${zeit(o.zeit)} · ${esc(o.grund || '')}</div></div>`).join('')
      : '<div class="meta">Noch keine Orders.</div>';

    warum();
    kurve();
  }

  // „Warum diese Werte?“ – die letzte Wochen-Umschichtung für Laien erklärt (Daten aus dem Protokolleintrag des Laufs)
  const ERGEBNIS = {
    gekauft: '✓ gekauft', depot: '✓ bleibt im Depot',
    pruefung: '… wartet auf den Nachrichten-Check durch Claude',
    markt: '– nicht gekauft: Markt-Ampel für diesen Bereich steht auf Rot',
    trend: '– nicht gekauft: Kurs liegt unter seinem Durchschnitt (fällt gerade)',
    gesperrt: '– nicht gekauft: vorübergehend gesperrt (Veto von Claude oder kurz nach einem Stop-Loss)',
    voll: '– nicht gekauft: alle Plätze waren schon besetzt',
  };
  const p1 = v => (v >= 0 ? '+' : '') + num(v * 100, 1) + ' %';
  const ruhe = v => v < 0.25 ? 'ruhig' : v < 0.45 ? 'mittel' : 'stark';

  function warum() {
    const b = bot.begruendung;
    $('b-warum').hidden = !b?.rangliste?.length;
    if (!b?.rangliste?.length) return;
    const tag = String(b.zeit).slice(0, 10), datum = new Date(b.zeit).toLocaleDateString('de-DE');
    const anzahl = b.anzahl || 4, trendTage = b.trend_tage || 100, marktTage = b.markt_tage || 200;
    const imDepot = new Set(bot.positionen.map(p => p.kennung));
    const heuteGekauft = new Set(bot.orders.filter(o => o.seite === 'kauf' && String(o.zeit).slice(0, 10) === tag).map(o => o.kennung));
    // ältere Einträge haben noch kein `ergebnis` → aus dem heutigen Bestand ableiten
    const erg = r => {
      const e = r.ergebnis || (imDepot.has(r.kennung) ? 'depot' : !r.trend ? 'trend' : 'voll');
      return e === 'depot' && heuteGekauft.has(r.kennung) ? 'gekauft' : e;
    };
    const zeilen = b.rangliste.map((r, i) => ({ ...r, platz: i + 1, erg: erg(r) }));

    $('b-warum-stand').textContent = `· Umschichtung vom ${datum}`;
    $('b-warum-intro').innerHTML = `Einmal pro Woche vergleicht der Automat ${b.verglichen ? `<b>${b.verglichen} Werte</b>` : 'alle Werte'}
      aus DAX 40, Nasdaq 100, 5 ETFs und 9 Kryptowährungen nach festen Regeln – ohne Bauchgefühl und ohne Tipps.
      Er kauft die <b>${anzahl} Werte mit den meisten Punkten</b>, die alle Prüfungen bestehen, jeweils
      ${anzahl === 4 ? 'für ein Viertel' : `für ${Math.round(100 / anzahl)} %`} des Geldes, damit kein einzelner Wert zu viel Gewicht hat.`;

    const ampel = ok => ok ? '🟢 grün' : '🔴 rot';
    const lage = (x, ok) => x == null ? (ok ? 'über' : 'unter') : `${num(Math.abs(x) * 100, 1)} % ${x > 0 ? 'über' : 'unter'}`;
    const f = b.filter || {}, m = b.markt || {};
    $('b-warum-schritte').innerHTML = [
      `<b>Markt-Ampel:</b> Aktien ${ampel(f.aktie)} – der Weltaktien-Index (MSCI World) liegt ${lage(m.aktie, f.aktie)} seinem Durchschnitt
        der letzten ${marktTage} Tage. Krypto ${ampel(f.krypto)} – Bitcoin liegt ${lage(m.krypto, f.krypto)} seinem Durchschnitt.
        Bei Rot kauft der Automat in diesem Bereich nichts Neues, denn ein fallender Gesamtmarkt zieht meist auch gute Einzelwerte mit nach unten.`,
      `<b>Punkte vergeben:</b> Für jeden Wert zählt, wie stark der Kurs in den letzten 3 und 6 Monaten gestiegen ist (Mittelwert aus beiden).
        Das wird durch die <i>Schwankung</i> geteilt: Ein ruhiger, gleichmäßiger Anstieg bekommt mehr Punkte als ein wildes Auf und Ab mit ähnlichem Ergebnis.`,
      `<b>Trend-Check:</b> Gekauft wird nur, wenn der Kurs über seinem Durchschnitt der letzten ${trendTage} Tage liegt – der Wert also gerade nicht fällt.`,
      `<b>Nachrichten-Check:</b> Vor jedem neuen Kauf sucht Claude nach schlechten Nachrichten (z. B. Gewinnwarnung, Übernahmeangebot, Betrug)
        und kann ein Veto einlegen. ${bot.demo ? 'Das ist noch im <b>Demo-Modus</b> – bisher wurde jeder Kauf ohne Prüfung freigegeben.' : 'Die Ergebnisse stehen unten unter „Kaufprüfungen“.'}`,
    ].map(t => `<li>${t}</li>`).join('');

    $('b-warum-tbl').tBodies[0].innerHTML = zeilen.map(r => `<tr class="${['gekauft', 'depot'].includes(r.erg) ? 'gekauft' : ''}">
        <td class="name"><span class="s">${r.platz}.</span> <span class="n">${esc(r.name || r.kennung)}</span> <span class="s">${esc(r.kennung)}</span></td>
        <td data-label="3 Monate" class="${cls(r.r3)}">${p1(r.r3)}</td>
        <td data-label="6 Monate" class="${cls(r.r6)}">${p1(r.r6)}</td>
        <td data-label="Schwankung" class="v">${r.vol != null ? `${num(r.vol * 100, 0)} % · ${ruhe(r.vol)}` : '–'}</td>
        <td data-label="Punkte" class="v">${r.score != null ? num(r.score, 2) : '–'}</td>
        <td class="erg l">${esc(ERGEBNIS[r.erg] || r.erg)}</td>
      </tr>`).join('');

    // ältere Umschichtungen haben noch keine Schwankung/Punkte gespeichert → Spalten ausblenden
    const mitVol = zeilen.some(r => r.vol != null);
    $('b-warum-tbl').classList.toggle('ohne-vol', !mitVol);

    // Beispiel: ein Wert, der stärker gestiegen ist als ein gekaufter, aber wegen größerer Schwankung dahinter liegt
    const gekauft = zeilen.filter(r => ['gekauft', 'depot'].includes(r.erg)), mittel = r => (r.r3 + r.r6) / 2;
    let beispiel = mitVol ? '' : 'Schwankung und Punkte je Wert werden ab der nächsten Umschichtung mitgespeichert und dann hier angezeigt.';
    for (const a of [...gekauft].reverse()) {
      const x = zeilen.find(r => r.platz > a.platz && !gekauft.includes(r) && r.vol != null && a.vol != null && mittel(r) > mittel(a) && r.vol > a.vol);
      if (x) {
        beispiel = `<b>Beispiel:</b> ${esc(x.name)} ist im Schnitt stärker gestiegen als ${esc(a.name)} (${p1(mittel(x))} gegenüber ${p1(mittel(a))}),
          schwankt aber stärker (${num(x.vol * 100, 0)} % statt ${num(a.vol * 100, 0)} % im Jahr). Deshalb bekommt es weniger Punkte und landet auf Platz ${x.platz}.`;
        break;
      }
    }
    $('b-warum-beispiel').innerHTML = beispiel;
    $('b-warum-beispiel').hidden = !beispiel;
  }

  // Wertverlauf des Automaten (ein Wert pro Tag + heutiger Stand) gegen MSCI World und Bitcoin
  function kurve() {
    const d = bot.depot, heute = new Date().toISOString().slice(0, 10);
    const eigen = new Map(bot.tageswerte.map(t => [t.tag, Number(t.wert)]));
    eigen.set(String(d.erstellt).slice(0, 10), eigen.get(String(d.erstellt).slice(0, 10)) ?? d.startkapital);
    eigen.set(heute, bot.gesamt);
    const tage = [...new Set([...eigen.keys(), ...(bot.vergleich.welt || []).map(x => x[0]), ...(bot.vergleich.bitcoin || []).map(x => x[0])])].sort();
    const reihe = paare => { const m = new Map(paare); let letzt = null; return tage.map(t => (m.has(t) ? (letzt = m.get(t)) : letzt)); };
    const ds = [{ label: 'Automat', data: reihe([...eigen]), borderColor: css('--accent'), borderWidth: 2.5 }];
    if (bot.vergleich.welt) ds.push({ label: 'MSCI World', data: reihe(bot.vergleich.welt), borderColor: css('--muted'), borderDash: [5, 4], borderWidth: 1.5 });
    if (bot.vergleich.bitcoin) ds.push({ label: 'Bitcoin', data: reihe(bot.vergleich.bitcoin), borderColor: '#f7931a', borderDash: [2, 3], borderWidth: 1.5 });
    ds.forEach(x => Object.assign(x, { pointRadius: tage.length < 15 ? 3 : 0, tension: .15, spanGaps: true }));
    $('b-chartinfo').textContent = bot.tageswerte.length < 2 ? 'Der Verlauf füllt sich mit jedem Tag (Tageswert ab 17:40).' : '';
    if (chart) chart.destroy();
    chart = new Chart($('b-chart'), { type: 'line',
      data: { labels: tage.map(t => new Date(t).toLocaleDateString('de-DE', { day: '2-digit', month: 'short' })), datasets: ds },
      options: { maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { labels: { color: css('--text'), boxWidth: 12 } }, tooltip: { callbacks: { label: c => `${c.dataset.label}: ${eur.format(c.raw)}` } } },
        scales: { x: { ticks: { color: css('--muted'), maxTicksLimit: 6, maxRotation: 0 }, grid: { display: false } },
          y: { ticks: { color: css('--muted'), callback: v => eur.format(v).replace(/,\d\d/, '') }, grid: { color: css('--line') } } } } });
  }

  // Not-Aus: Automat anhalten bzw. fortsetzen
  $('b-schalter').onclick = async () => {
    const anhalten = !bot.depot.pausiert;
    if (anhalten && !confirm('Automat anhalten? Er kauft und verkauft dann nichts mehr – auch keine Stop-Loss-Verkäufe.')) return;
    try { await API.botPausieren(bot.depot.id, anhalten); } catch (e) { alert(e.message); }
    laden();
  };
})();
