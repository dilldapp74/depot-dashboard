// Handelsautomat – Anzeige des Automat-Depots (nur Online-Fassung mit Supabase).
// Gehandelt wird ausschließlich in der Edge Function (Cron); hier wird nur angezeigt und angehalten/fortgesetzt.
// Nutzt die Hilfsfunktionen aus index.html (eur, pct, signed, cls, qty, priceFmt, esc, css).

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

    kurve();
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
