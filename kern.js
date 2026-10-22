// Taschengeld – gemeinsamer Kern für die App und das Apps-Script-Backend.
// Reine Prüf- und Rechenregeln, ohne DOM und ohne Google-Dienste.
// In Apps Script steht diese Datei unverändert als „Kern.gs“ neben Code.gs.
var Kern = (function () {
  'use strict';

  // Vorzeichen je Art: 1 = nur Eingang, -1 = nur Ausgang, 0 = beides.
  // Andere Arten aus Kleinbuchstaben werden ohne Vorzeichenprüfung angenommen,
  // damit eine neue Kategorie in der App kein neues Backend braucht.
  var ARTEN = { taschengeld: 1, geschenk: 1, belohnung: 1, mithelfen: 1,
    ausgabe: -1, spielsachen: -1, suessigkeiten: -1, sparziel: -1, sonstiges: 0 };
  var FARBEN = 6;
  var MAX_BETRAG = 1000000;   // 10.000 € in Cent
  var MAX_NACHHOLEN = 400;    // so viele Tage bucht die Automatik höchstens nach
  var MAX_OPS = 200;          // Änderungen je Anfrage

  // Spalten der Google-Tabelle; alle Werte werden als Text gespeichert
  var TABELLEN = {
    Kinder:    { feld: 'kinder',    spalten: ['id', 'name', 'emoji', 'farbe', 'code', 'pos', 'angelegt', 'archiviert'] },
    Buchungen: { feld: 'buchungen', spalten: ['id', 'kindId', 'datum', 'betrag', 'art', 'text', 'erstellt', 'storniert', 'stornoGrund', 'quelle'] },
    Sparziele: { feld: 'sparziele', spalten: ['id', 'kindId', 'name', 'emoji', 'betrag', 'pos', 'status', 'erstellt', 'erledigt'] },
    Regeln:    { feld: 'regeln',    spalten: ['kindId', 'aktiv', 'betrag', 'rhythmus', 'tag', 'ab', 'geaendert'] }
  };

  function hat(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function finde(liste, feld, wert) {
    for (var i = 0; i < liste.length; i++) if (liste[i][feld] === wert) return liste[i];
    return null;
  }
  // Steuerzeichen raus, keine führenden Formelzeichen (die Tabelle würde sie als Formel lesen)
  function text(s, max) {
    var t = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/^[=+\-@\s]+/, '');
    return Array.from(t).slice(0, max).join('').trim();
  }
  function istId(s) { return typeof s === 'string' && /^[A-Za-z0-9_-]{1,60}$/.test(s); }
  function ganz(v) {
    var n = typeof v === 'number' ? v : (/^-?\d+$/.test(String(v)) ? Number(v) : NaN);
    return Number.isSafeInteger(n) ? n : NaN;
  }
  function istDatum(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    var d = new Date(s + 'T00:00:00Z');
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }
  function istZeit(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(s); }
  function zeitOder(v, standard) { return istZeit(v) && v <= standard ? v : standard; }
  function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, ''); }

  // Datumsrechnung auf 'yyyy-mm-dd' in UTC, damit Zeitzonen nichts verschieben
  function tagNr(s) { return Math.round(Date.parse(s + 'T00:00:00Z') / 864e5); }
  function datumAus(n) { return new Date(n * 864e5).toISOString().slice(0, 10); }
  function wochentag(s) { var w = new Date(tagNr(s) * 864e5).getUTCDay(); return w === 0 ? 7 : w; } // 1 = Montag
  function tageImMonat(s) { return new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7), 0)).getUTCDate(); }

  // ---------- Automatisches Taschengeld ----------
  function regelAktiv(r) { return !!r && r.aktiv === 'ja' && istDatum(r.ab) && ganz(r.betrag) > 0; }
  function passt(r, s) {
    var tag = ganz(r.tag);
    if (r.rhythmus === 'woche') return wochentag(s) === tag;
    if (r.rhythmus === 'monat') return +s.slice(8, 10) === Math.min(tag, tageImMonat(s)); // 31 = Monatsletzter
    return false;
  }
  function faelligeTermine(r, heute) {
    if (!regelAktiv(r) || !istDatum(heute)) return [];
    var aus = [], bis = tagNr(heute);
    for (var n = Math.max(tagNr(r.ab), bis - MAX_NACHHOLEN); n <= bis; n++) {
      var s = datumAus(n);
      if (passt(r, s)) aus.push(s);
    }
    return aus;
  }
  function naechsterTermin(r, heute) {
    if (!regelAktiv(r) || !istDatum(heute)) return '';
    var n = Math.max(tagNr(r.ab), tagNr(heute) + 1);
    for (var i = 0; i < 62; i++, n++) { var s = datumAus(n); if (passt(r, s)) return s; }
    return '';
  }
  // Jede fällige Zahlung hat die feste ID auto-<Kind>-<Datum>: nie doppelt, auch nicht nach einem Storno
  function automatikBuchen(db, ctx) {
    var ids = {};
    db.buchungen.forEach(function (b) { ids[b.id] = true; });
    db.regeln.forEach(function (r) {
      var k = finde(db.kinder, 'id', r.kindId);
      if (!k || k.archiviert) return;
      faelligeTermine(r, ctx.heute).forEach(function (datum) {
        var id = 'auto-' + k.id + '-' + datum;
        if (ids[id]) return;
        ids[id] = true;
        db.buchungen.push({ id: id, kindId: k.id, datum: datum, betrag: String(ganz(r.betrag)), art: 'taschengeld',
          text: 'Taschengeld (automatisch)', erstellt: ctx.jetzt, storniert: '', stornoGrund: '', quelle: 'auto' });
        ctx.geaendert.Buchungen = true;
      });
    });
  }

  function stand(buchungen, kindId) {
    var s = 0;
    buchungen.forEach(function (b) { if (b.kindId === kindId && !b.storniert) s += ganz(b.betrag) || 0; });
    return s;
  }

  // ---------- Änderungen ----------
  // Jede Änderung ist wiederholbar: doppelt gesendet ändert nichts. Rückgabe '' = in Ordnung, sonst Grund.
  function opAnwenden(db, op, ctx) {
    var d = (op && op.daten) || {};
    var typ = op && op.typ;

    if (typ === 'buchung') {
      if (!istId(d.id)) return 'Ungültige ID';
      if (finde(db.buchungen, 'id', d.id)) return '';
      if (!finde(db.kinder, 'id', d.kindId)) return 'Kind unbekannt';
      var bekannt = typeof d.art === 'string' && hat(ARTEN, d.art);
      if (!bekannt && !(typeof d.art === 'string' && /^[a-z]{2,20}$/.test(d.art))) return 'Ungültige Art';
      var b = ganz(d.betrag);
      if (!b || Math.abs(b) > MAX_BETRAG) return 'Ungültiger Betrag';
      if (bekannt && ARTEN[d.art] * b < 0) return 'Vorzeichen passt nicht zur Art';
      if (!istDatum(d.datum)) return 'Ungültiges Datum';
      db.buchungen.push({ id: d.id, kindId: d.kindId, datum: d.datum, betrag: String(b), art: d.art, text: text(d.text, 120),
        erstellt: zeitOder(d.erstellt, ctx.jetzt), storniert: '', stornoGrund: '',
        quelle: d.quelle === 'auto' && d.id.indexOf('auto-') === 0 ? 'auto' : 'hand' });
      ctx.geaendert.Buchungen = true;
      return '';
    }

    if (typ === 'storno') {
      var x = finde(db.buchungen, 'id', d.id);
      if (!x) return 'Buchung unbekannt';
      if (!x.storniert) {
        x.storniert = zeitOder(d.zeit, ctx.jetzt);
        x.stornoGrund = text(d.grund, 120);
        ctx.geaendert.Buchungen = true;
      }
      return '';
    }

    if (typ === 'kind') {
      if (!istId(d.id)) return 'Ungültige ID';
      var k = finde(db.kinder, 'id', d.id);
      var name = d.name != null ? text(d.name, 30) : null;
      if ((!k || d.name != null) && !name) return 'Name fehlt';
      var farbe = d.farbe != null ? ganz(d.farbe) : null;
      if (farbe !== null && !(farbe >= 0 && farbe < FARBEN)) return 'Ungültige Farbe';
      var pos = d.pos != null ? ganz(d.pos) : null;
      if (pos !== null && !(pos >= 0)) return 'Ungültige Position';
      if (!k) {
        k = { id: d.id, name: name, emoji: '🙂', farbe: '0', code: ctx.neuerCode(), pos: String(db.kinder.length),
          angelegt: zeitOder(d.angelegt, ctx.jetzt), archiviert: '' };
        db.kinder.push(k);
      } else if (d.neuerCode) {
        k.code = ctx.neuerCode();
      }
      if (name) k.name = name;
      if (d.emoji != null) k.emoji = text(d.emoji, 8) || '🙂';
      if (farbe !== null) k.farbe = String(farbe);
      if (pos !== null) k.pos = String(pos);
      if (d.archiviert != null) k.archiviert = d.archiviert ? (k.archiviert || ctx.jetzt) : '';
      ctx.geaendert.Kinder = true;
      return '';
    }

    if (typ === 'sparziel') {
      if (!istId(d.id)) return 'Ungültige ID';
      var z = finde(db.sparziele, 'id', d.id);
      var zName = d.name != null ? text(d.name, 40) : null;
      var zBetrag = d.betrag != null ? ganz(d.betrag) : null;
      var zPos = d.pos != null ? ganz(d.pos) : null;
      if ((!z || d.name != null) && !zName) return 'Name fehlt';
      if ((!z || d.betrag != null) && !(zBetrag > 0 && zBetrag <= MAX_BETRAG)) return 'Ungültiger Betrag';
      if (zPos !== null && !(zPos >= 0)) return 'Ungültige Position';
      if (d.status != null && !/^(aktiv|erreicht|aufgegeben)$/.test(d.status)) return 'Ungültiger Status';
      if (!z) {
        if (!finde(db.kinder, 'id', d.kindId)) return 'Kind unbekannt';
        z = { id: d.id, kindId: d.kindId, name: zName, emoji: '🎯', betrag: String(zBetrag), pos: '0', status: 'aktiv',
          erstellt: zeitOder(d.erstellt, ctx.jetzt), erledigt: '' };
        db.sparziele.push(z);
      }
      if (zName) z.name = zName;
      if (zBetrag !== null) z.betrag = String(zBetrag);
      if (zPos !== null) z.pos = String(zPos);
      if (d.emoji != null) z.emoji = text(d.emoji, 8) || '🎯';
      if (d.status != null && d.status !== z.status) {
        z.status = d.status;
        z.erledigt = d.status === 'aktiv' ? '' : (istDatum(d.erledigt) ? d.erledigt : ctx.heute);
      }
      ctx.geaendert.Sparziele = true;
      return '';
    }

    if (typ === 'regel') {
      var kd = finde(db.kinder, 'id', d.kindId);
      if (!kd) return 'Kind unbekannt';
      var aktiv = d.aktiv === 'ja' || d.aktiv === true ? 'ja' : 'nein';
      var rb = ganz(d.betrag), rh = d.rhythmus, tg = ganz(d.tag), ab = d.ab;
      if (!(rb >= 0 && rb <= MAX_BETRAG)) return 'Ungültiger Betrag';
      if (rh !== 'woche' && rh !== 'monat') return 'Ungültiger Rhythmus';
      if (!(tg >= 1 && tg <= (rh === 'woche' ? 7 : 31))) return 'Ungültiger Tag';
      if (!istDatum(ab)) return 'Ungültiges Datum';
      if (aktiv === 'ja' && !(rb > 0)) return 'Betrag fehlt';
      var alt = finde(db.regeln, 'kindId', kd.id);
      // Wechselt der Zahltag, wird nie rückwirkend nach dem neuen Tag nachgebucht
      if (alt && alt.aktiv === 'ja' && (alt.rhythmus !== rh || ganz(alt.tag) !== tg) && ab < ctx.heute) ab = ctx.heute;
      if (!alt) { alt = { kindId: kd.id }; db.regeln.push(alt); }
      alt.aktiv = aktiv; alt.betrag = String(rb); alt.rhythmus = rh; alt.tag = String(tg); alt.ab = ab; alt.geaendert = ctx.jetzt;
      ctx.geaendert.Regeln = true;
      return '';
    }

    return 'Unbekannte Änderung';
  }

  // ---------- Anfrage ----------
  // ctx: { heute, jetzt, schluessel (null = Lokalbetrieb ohne Anmeldung), neuerCode() }
  function verarbeite(db, req, ctx) {
    req = req || {};
    ['kinder', 'buchungen', 'sparziele', 'regeln'].forEach(function (f) { if (!Array.isArray(db[f])) db[f] = []; });
    ctx.geaendert = {};

    var rolle = '', kind = null;
    if (ctx.schluessel === null) rolle = 'eltern';
    else if (!norm(ctx.schluessel)) return { ok: false, fehler: 'einrichten' };
    else if (req.schluessel != null && norm(req.schluessel) === norm(ctx.schluessel)) rolle = 'eltern';
    else if (req.kind) {
      var c = norm(req.kind);
      kind = db.kinder.filter(function (k) { return k.code && norm(k.code) === c && !k.archiviert; })[0] || null;
      if (kind) rolle = 'kind';
    }
    if (!rolle) return { ok: false, fehler: req.kind ? 'link' : 'schluessel' };

    automatikBuchen(db, ctx);
    var ergebnisse = [];
    if (rolle === 'eltern' && Array.isArray(req.ops)) {
      req.ops.slice(0, MAX_OPS).forEach(function (op) {
        var f;
        try { f = opAnwenden(db, op, ctx); } catch (e) { f = 'Fehler: ' + (e && e.message); }
        ergebnisse.push({ uid: op && op.uid, fehler: f });
      });
      automatikBuchen(db, ctx);
    }

    var aus = { ok: true, rolle: rolle, heute: ctx.heute, ergebnisse: ergebnisse };
    if (rolle === 'eltern') {
      aus.kinder = db.kinder; aus.buchungen = db.buchungen; aus.sparziele = db.sparziele; aus.regeln = db.regeln;
    } else {
      var id = kind.id, nur = function (x) { return x.kindId === id; };
      aus.kinder = [{ id: id, name: kind.name, emoji: kind.emoji, farbe: kind.farbe, pos: kind.pos }];
      aus.buchungen = db.buchungen.filter(nur);
      aus.sparziele = db.sparziele.filter(nur);
      aus.regeln = db.regeln.filter(nur);
    }
    return aus;
  }

  return {
    ARTEN: ARTEN, FARBEN: FARBEN, MAX_BETRAG: MAX_BETRAG, TABELLEN: TABELLEN,
    ganz: ganz, istDatum: istDatum, tagNr: tagNr, datumAus: datumAus, wochentag: wochentag,
    regelAktiv: regelAktiv, faelligeTermine: faelligeTermine, naechsterTermin: naechsterTermin,
    automatikBuchen: automatikBuchen, stand: stand, opAnwenden: opAnwenden, verarbeite: verarbeite
  };
})();
