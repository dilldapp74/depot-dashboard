// Spieldepot (Paper-Trading) – nur in der Online-Fassung mit Supabase.
// Orders, Status und Backtest rechnet die Edge Function "depot"; hier wird nur angezeigt und eingegeben.
// Nutzt die Hilfsfunktionen aus index.html (eur, pct, signed, cls, qty, priceFmt, esc, css, localGet/localSet).

(function () {
  if (API.modus !== 'supabase') return;
  const $ = id => document.getElementById(id);
  let sim = null, simDepot = localGet('simDepot') || null, simChart = null, btChart = null, simTimer = null;

  // ---------- Ansicht umschalten: Mein Depot / Spieldepot ----------
  function ansicht(v) {
    document.body.classList.toggle('v-spiel', v === 'spiel');
    document.querySelectorAll('.ansicht button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
    localSet('ansicht', v);
    if (v === 'spiel') {
      simLaden();
      if (!simTimer) simTimer = setInterval(() => {
        if (document.body.classList.contains('v-spiel') && !document.body.classList.contains('abgemeldet')) simLaden();
      }, 60000);
    }
  }
  document.querySelectorAll('.ansicht button').forEach(b => b.onclick = () => ansicht(b.dataset.v));
  $('refresh').addEventListener('click', () => { if (document.body.classList.contains('v-spiel')) simLaden(); });

  // ---------- Laden und Zeichnen ----------
  async function simLaden() {
    if (document.body.classList.contains('abgemeldet')) return;
    $('s-stamp').textContent = 'Lade …';
    try { sim = await API.simStatus(simDepot); }
    catch (e) { $('s-stamp').textContent = 'Fehler: ' + e.message; return; }
    if (!sim.depots.length) { $('s-leer').hidden = false; $('s-inhalt').hidden = true; return; }
    $('s-leer').hidden = true; $('s-inhalt').hidden = false;
    simDepot = sim.depot.id; localSet('simDepot', simDepot);
    zeichnen();
  }

  function zeichnen() {
    const d = sim.depot, start = Number(d.startkapital), pl = sim.gesamt - start;
    $('s-depot').innerHTML = sim.depots.map(x => `<option value="${esc(x.id)}" ${x.id === d.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
    $('s-stamp').textContent = 'Stand: ' + new Date(sim.generated * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    $('s-total').textContent = eur.format(sim.gesamt);
    $('s-start').textContent = 'Start: ' + eur.format(start);
    $('s-bar').textContent = eur.format(d.bargeld);
    $('s-gebinfo').textContent = `Gebühr je Order: ${eur.format(d.gebuehr)}`;
    const e = $('s-pl'); e.textContent = signed(pl); e.className = 'val ' + cls(pl);
    const ep = $('s-plpct'); ep.textContent = pct(pl / start * 100); ep.className = 'sub ' + cls(pl);
    const regelOrders = sim.orders.filter(o => o.quelle !== 'manuell').length;
    $('s-anz').textContent = sim.orders.length + (sim.orders.length >= 50 ? '+' : '');
    $('s-anzinfo').textContent = regelOrders ? `davon ${regelOrders} durch Regeln` : 'alle manuell';

    // Positionen
    const tb = $('s-tbl').tBodies[0];
    tb.innerHTML = sim.positionen.length ? sim.positionen.map(p => `<tr>
        <td class="name"><div class="n">${esc(p.name || p.kennung)}</div><div class="s">${esc(p.kennung)}${p.fehler ? ' · <span class="err">' + esc(p.fehler) + '</span>' : ''}</div></td>
        <td data-label="Anteile">${qty(p.anteile)}</td>
        <td data-label="Einstand">${priceFmt(p.kosten / p.anteile)}</td>
        <td data-label="Kurs">${p.kurs ? priceFmt(p.kurs) : '–'}</td>
        <td data-label="Wert"><b>${eur.format(p.wert)}</b></td>
        <td data-label="Heute" class="${cls(p.tag_pct)}">${pct(p.tag_pct)}</td>
        <td data-label="G/V" class="${cls(p.pl_abs)}">${signed(p.pl_abs)}<div class="s">${pct(p.pl_pct)}</div></td>
      </tr>`).join('') : '<tr><td colspan="7" class="empty">Noch keine Positionen – rechts eine Order aufgeben oder eine Regel anlegen.</td></tr>';

    // Orders
    $('s-orders').innerHTML = sim.orders.length ? sim.orders.map(o => `<div class="e">
        <b class="${o.seite === 'kauf' ? '' : 'neg'}">${o.seite === 'kauf' ? 'Kauf' : 'Verkauf'} ${qty(o.anteile)} × ${esc(o.name || o.kennung)}</b>
        zu ${priceFmt(o.kurs)} = ${eur.format(o.anteile * o.kurs)} · Gebühr ${eur.format(o.gebuehr)}
        <div class="s">${new Date(o.zeit).toLocaleString('de-DE')} · ${o.quelle === 'manuell' ? 'manuell' : 'Regel ' + esc(TYPNAME[o.quelle.slice(6)] || o.quelle)}</div></div>`).join('')
      : '<div class="meta">Noch keine Orders.</div>';

    regelnZeichnen();
    kurvenZeichnen();
    // Vorschläge für das Kennungsfeld: echte Positionen und Spieldepot-Positionen
    const vorschlaege = new Map();
    (typeof data !== 'undefined' && data?.positions || []).forEach(p => vorschlaege.set(p.symbol || p.id, p.name));
    sim.positionen.forEach(p => vorschlaege.set(p.kennung, p.name));
    $('s-liste').innerHTML = [...vorschlaege].map(([k, n]) => `<option value="${esc(k)}">${esc(n || '')}</option>`).join('');
  }

  function kurvenZeichnen() {
    const heute = new Date().toISOString().slice(0, 10);
    const punkte = sim.tageswerte.map(t => [t.tag, Number(t.wert)]);
    if (!punkte.length || punkte.at(-1)[0] !== heute) punkte.push([heute, sim.gesamt]);   // heutiger Stand live
    punkte.unshift([sim.depot.erstellt.slice(0, 10), Number(sim.depot.startkapital)]);
    const up = punkte.at(-1)[1] >= Number(sim.depot.startkapital), farbe = up ? css('--pos') : css('--neg');
    $('s-chartinfo').textContent = sim.tageswerte.length < 2 ? 'Der Verlauf füllt sich mit jedem Tag (Tageswert ab 17:40).' : '';
    if (simChart) simChart.destroy();
    simChart = new Chart($('s-chart'), { type: 'line',
      data: { labels: punkte.map(p => new Date(p[0]).toLocaleDateString('de-DE', { day: '2-digit', month: 'short' })),
        datasets: [{ data: punkte.map(p => p[1]), borderColor: farbe, backgroundColor: farbe + '22', fill: true, pointRadius: punkte.length < 15 ? 3 : 0, borderWidth: 2, tension: .15 }] },
      options: { maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => eur.format(c.raw) } } },
        scales: { x: { ticks: { color: css('--muted'), maxTicksLimit: 6, maxRotation: 0 }, grid: { display: false } },
          y: { ticks: { color: css('--muted'), callback: v => eur.format(v).replace(/,\d\d/, '') }, grid: { color: css('--line') } } } } });
  }

  // ---------- Regeln ----------
  const TYPNAME = { sparplan: 'Sparplan', nachkauf: 'Nachkaufen', trend: 'Trendfolge', rebalancing: 'Rebalancing' };
  function regelText(typ, p) {
    if (typ === 'sparplan') return `${eur.format(p.betrag)} in ${p.kennung}, jeden Monat ab dem ${p.tag}.`;
    if (typ === 'nachkauf') return `${p.kennung}: für ${eur.format(p.betrag)} kaufen, wenn ${num(p.rueckgang, 0)} % unter dem ${p.tage}-Tage-Hoch (höchstens 1× pro Woche)`;
    if (typ === 'trend') return `${p.kennung}: über dem ${p.tage}-Tage-Schnitt für bis zu ${eur.format(p.betrag)} kaufen, darunter alles verkaufen`;
    if (typ === 'rebalancing') return `Zielgewichte ${(p.ziele || []).map(z => `${z.kennung} ${num(z.gewicht, 0)} %`).join(', ')} · anpassen ab ${num(p.schwelle, 0)} % Abweichung`;
    return typ;
  }
  function regelnZeichnen() {
    $('s-regeln').innerHTML = sim.regeln.length ? sim.regeln.map((r, i) => `<div class="regel ${r.aktiv ? '' : 'off'}">
        <div class="kopf"><input type="checkbox" data-i="${i}" ${r.aktiv ? 'checked' : ''} title="Aktiv">
          <span class="txt"><b>${TYPNAME[r.typ]}</b> · ${esc(regelText(r.typ, r.parameter))}</span>
          <button data-bt="${i}">Backtest</button><button data-del="${i}" title="Löschen">✕</button></div>
        ${r.letzte_meldung ? `<div class="s meta">Zuletzt: ${esc(r.letzte_meldung)}</div>` : ''}</div>`).join('')
      : '<div class="meta">Noch keine Regeln.</div>';
    $('s-regeln').querySelectorAll('input[type=checkbox]').forEach(c => c.onchange = async () => {
      try { await API.simRegelAktiv(sim.regeln[c.dataset.i].id, c.checked); } catch (e) { alert(e.message); } simLaden();
    });
    $('s-regeln').querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!confirm('Regel löschen? Bereits ausgeführte Orders bleiben im Spieldepot.')) return;
      try { await API.simRegelLoeschen(sim.regeln[b.dataset.del].id); } catch (e) { alert(e.message); } simLaden();
    });
    $('s-regeln').querySelectorAll('[data-bt]').forEach(b => b.onclick = () => { const r = sim.regeln[b.dataset.bt]; backtest(r.typ, r.parameter, b); });
  }

  // Eingabefelder je Regeltyp
  const FELDER = {
    sparplan: [['kennung', 'ISIN / Ticker', 'EUNL.DE'], ['betrag', 'Betrag € pro Monat', 500], ['tag', 'Ausführungstag (1–28)', 1]],
    nachkauf: [['kennung', 'ISIN / Ticker', 'EUNL.DE'], ['rueckgang', 'Rückgang ab %', 10], ['tage', 'Hoch der letzten … Tage', 20], ['betrag', 'Kaufbetrag €', 1000]],
    trend: [['kennung', 'ISIN / Ticker', 'EUNL.DE'], ['tage', 'Gleitender Durchschnitt (Tage)', 200], ['betrag', 'Höchstens investieren €', 10000]],
    rebalancing: [['ziele', 'Zielgewichte (Kennung Prozent, getrennt durch Komma)', 'EUNL.DE 60, IS3N.DE 20, BTC-EUR 10', true], ['schwelle', 'Anpassen ab Abweichung %', 5]],
  };
  function felderZeichnen() {
    const typ = $('s-typ').value;
    $('s-felder').innerHTML = FELDER[typ].map(([k, l, v, voll]) =>
      `<label class="${voll ? 'voll' : ''}">${l}<input data-f="${k}" value="${esc(v)}" ${k === 'kennung' || k === 'ziele' ? 'list="s-liste" autocomplete="off"' : 'inputmode="decimal"'}></label>`).join('');
  }
  $('s-typ').onchange = felderZeichnen;
  felderZeichnen();

  function formularParameter() {
    const typ = $('s-typ').value, p = {};
    $('s-felder').querySelectorAll('input').forEach(i => p[i.dataset.f] = i.value.trim());
    const zahl = (k, min, max) => { const v = Number(String(p[k]).replace(',', '.')); if (!(v >= min && v <= max)) throw new Error(`Bitte einen gültigen Wert für „${FELDER[typ].find(f => f[0] === k)[1]}“ eingeben (${min}–${max}).`); p[k] = v; };
    if (typ === 'rebalancing') {
      // Trenner: Semikolon oder ein Komma, nach dem eine neue Kennung beginnt – „20,5“ bleibt eine Zahl
      const ziele = String(p.ziele).split(/;|\n|,(?=\s*[A-Za-z])/).map(t => t.trim()).filter(Boolean).map(t => {
        const m = t.match(/^(\S+)\s+([\d.,]+)\s*%?$/);
        if (!m) throw new Error(`„${t}“ verstehe ich nicht – Format: Kennung Prozent, z. B. „EUNL.DE 60“.`);
        return { kennung: m[1], gewicht: Number(m[2].replace(',', '.')) };
      });
      if (!ziele.length) throw new Error('Bitte mindestens ein Zielgewicht angeben.');
      if (ziele.reduce((s, z) => s + z.gewicht, 0) > 100) throw new Error('Die Zielgewichte ergeben zusammen mehr als 100 %.');
      p.ziele = ziele; zahl('schwelle', 1, 50);
    } else {
      if (!p.kennung) throw new Error('Bitte eine ISIN oder einen Ticker angeben.');
      zahl('betrag', 1, 10000000);
      if (typ === 'sparplan') zahl('tag', 1, 28);
      if (typ === 'nachkauf') { zahl('rueckgang', 1, 90); zahl('tage', 2, 250); }
      if (typ === 'trend') zahl('tage', 5, 250);
    }
    return { typ, p };
  }
  $('s-regelform').onsubmit = async ev => {
    ev.preventDefault();
    try { const { typ, p } = formularParameter(); await API.simRegelNeu(simDepot, typ, p); felderZeichnen(); simLaden(); }
    catch (e) { alert(e.message); }
  };
  $('s-bt').onclick = () => { try { const { typ, p } = formularParameter(); backtest(typ, p, $('s-bt')); } catch (e) { alert(e.message); } };

  // ---------- Backtest ----------
  async function backtest(typ, p, knopf) {
    const vorher = knopf.textContent; knopf.disabled = true; knopf.textContent = 'rechnet …';
    let b;
    try { b = await API.simBacktest(typ, p, Number(sim?.depot?.startkapital) || 25000, Number(sim?.depot?.gebuehr ?? 1)); }
    catch (e) { alert('Backtest fehlgeschlagen: ' + e.message); return; }
    finally { knopf.disabled = false; knopf.textContent = vorher; }
    $('bt-titel').textContent = 'Backtest: ' + TYPNAME[typ];
    $('bt-sub').textContent = `${regelText(typ, p)} · ${new Date(b.von).toLocaleDateString('de-DE')} – ${new Date(b.bis).toLocaleDateString('de-DE')} · Start ${eur.format(b.startkapital)}`;
    const box = (l, v, c = '') => `<div><div class="l">${l}</div><div class="v ${c}">${v}</div></div>`;
    $('bt-stats').innerHTML = [
      box('Regel: Endwert', eur.format(b.regel.endwert)), box('Regel: Rendite', pct(b.regel.rendite), cls(b.regel.rendite)),
      box('Regel: größter Rückgang', pct(b.regel.max_rueckgang), 'neg'), box('Orders / Gebühren', `${b.trades} / ${eur.format(b.gebuehren)}`),
      box('Am Start kaufen: Endwert', eur.format(b.halten.endwert)), box('Am Start kaufen: Rendite', pct(b.halten.rendite), cls(b.halten.rendite)),
      box('Am Start kaufen: größter Rückgang', pct(b.halten.max_rueckgang), 'neg'),
    ].join('');
    $('bt-hinweis').textContent = b.hinweis + ' „Am Start kaufen“ legt das ganze Startkapital am ersten Tag an. Vergangene Ergebnisse sagen nichts über die Zukunft.';
    $('btdlg').showModal();
    if (btChart) btChart.destroy();
    btChart = new Chart($('bt-chart'), { type: 'line',
      data: { labels: b.regel.werte.map(w => new Date(w[0]).toLocaleDateString('de-DE', { day: '2-digit', month: 'short' })),
        datasets: [
          { label: 'Regel', data: b.regel.werte.map(w => w[1]), borderColor: css('--accent'), pointRadius: 0, borderWidth: 2, tension: .15 },
          { label: 'Am Start kaufen', data: b.halten.werte.map(w => w[1]), borderColor: css('--muted'), borderDash: [5, 4], pointRadius: 0, borderWidth: 1.5, tension: .15 }] },
      options: { maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { labels: { color: css('--text'), boxWidth: 12 } }, tooltip: { callbacks: { label: c => `${c.dataset.label}: ${eur.format(c.raw)}` } } },
        scales: { x: { ticks: { color: css('--muted'), maxTicksLimit: innerWidth <= 640 ? 4 : 7, maxRotation: 0 }, grid: { display: false } },
          y: { ticks: { color: css('--muted'), callback: v => eur.format(v).replace(/,\d\d/, '') }, grid: { color: css('--line') } } } } });
  }
  $('bt-zu').onclick = () => $('btdlg').close();
  $('btdlg').addEventListener('click', e => { if (e.target === $('btdlg')) $('btdlg').close(); });

  // ---------- Orders ----------
  const seite = () => document.querySelector('input[name="s-seite"]:checked').value;
  function seiteAnzeigen() {
    const verkauf = seite() === 'verkauf';
    document.querySelector('.nur-verkauf').style.display = verkauf ? '' : 'none';
    $('s-betrag').disabled = verkauf && $('s-alles').checked;
  }
  document.querySelectorAll('input[name="s-seite"]').forEach(r => r.onchange = seiteAnzeigen);
  $('s-alles').onchange = seiteAnzeigen;
  seiteAnzeigen();

  $('s-order').onsubmit = async ev => {
    ev.preventDefault();
    const s = seite(), alles = s === 'verkauf' && $('s-alles').checked;
    const betrag = Number(String($('s-betrag').value).replace(/\./g, '').replace(',', '.'));
    if (!alles && !(betrag > 0)) return alert('Bitte einen Betrag in € eingeben.');
    const knopf = $('s-senden'); knopf.disabled = true; knopf.textContent = 'wird ausgeführt …';
    try {
      const o = await API.simOrder({ depot_id: simDepot, kennung: $('s-kennung').value.trim(), seite: s, betrag: alles ? undefined : betrag, alles });
      $('s-orderinfo').innerHTML = `<b>${o.seite === 'kauf' ? 'Gekauft' : 'Verkauft'}:</b> ${qty(o.anteile)} × ${esc(o.name)} zu ${priceFmt(o.kurs)} (Gebühr ${eur.format(o.gebuehr)})`;
      $('s-betrag').value = ''; $('s-alles').checked = false; seiteAnzeigen();
      simLaden();
    } catch (e) { $('s-orderinfo').innerHTML = `<span class="err">${esc(e.message)}</span>`; }
    finally { knopf.disabled = false; knopf.textContent = 'Order ausführen'; }
  };

  // ---------- Spieldepots verwalten ----------
  $('s-depot').onchange = () => { simDepot = $('s-depot').value; simLaden(); };
  $('s-neu').onclick = () => { $('s-leer').hidden = false; $('s-leer').scrollIntoView({ behavior: 'smooth' }); };
  $('s-anlegen').onsubmit = async ev => {
    ev.preventDefault();
    const zahl = v => Number(String(v).replace(/\./g, '').replace(',', '.'));
    try {
      simDepot = await API.simAnlegen($('s-name').value.trim() || 'Spieldepot', zahl($('s-kapital').value), zahl($('s-gebuehr').value));
      simLaden();
    } catch (e) { alert('Anlegen fehlgeschlagen: ' + e.message); }
  };
  $('s-loeschen').onclick = async () => {
    if (!confirm(`Spieldepot „${sim.depot.name}“ mit allen Orders und Regeln löschen?`)) return;
    try { await API.simLoeschen(simDepot); simDepot = null; localSet('simDepot', ''); simLaden(); } catch (e) { alert(e.message); }
  };

  // ---------- Start ----------
  sb.auth.onAuthStateChange((_e, session) => { if (session && document.body.classList.contains('v-spiel')) setTimeout(simLaden, 0); });
  ansicht(localGet('ansicht') === 'spiel' ? 'spiel' : 'echt');
})();
