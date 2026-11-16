// Simulateur minimal des services Google Apps Script, pour exécuter Code.gs
// tel quel dans Node (tests unitaires et webhook local des tests de bout en bout).
import fs from "node:fs";
import vm from "node:vm";
import crypto from "node:crypto";

const colIndex = (lettres) => lettres.split("").reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);

class Plage {
  constructor(sheet, r, c, nr, nc) { Object.assign(this, { sheet, r, c, nr, nc }); }
  _cells(fn) { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) fn(this.r + i, this.c + j, i, j); return this; }
  setValues(v) { return this._cells((r, c, i, j) => this.sheet._set(r, c, v[i][j], null)); }
  setValue(v) { return this._cells((r, c) => this.sheet._set(r, c, v, null)); }
  setFormulas(f) { return this._cells((r, c, i, j) => this.sheet._set(r, c, "", f[i][j])); }
  getValues() { const o = []; this._cells((r, c, i) => { (o[i] ||= []).push(this.sheet._get(r, c)); }); return o; }
  getValue() { return this.sheet._get(this.r, this.c); }
  getFormulas() { const o = []; this._cells((r, c, i) => { (o[i] ||= []).push(this.sheet._getF(r, c)); }); return o; }
  getDisplayValues() {
    return this.getValues().map((l) => l.map((v) => v instanceof Date ? v.toISOString() : v === true ? "TRUE" : v === false ? "FALSE" : String(v ?? "")));
  }
  insertCheckboxes() { return this._cells((r, c) => { if (this.sheet._get(r, c) === "") this.sheet._set(r, c, false, null); }); }
}
for (const m of ["setNumberFormat", "setFontWeight", "setBackground", "setWrap", "setVerticalAlignment", "setDataValidation"]) {
  Plage.prototype[m] = function () { return this; };
}

class Feuille {
  constructor(nom) { this.nom = nom; this.cells = new Map(); this.formules = new Map(); }
  _k(r, c) { return r + ":" + c; }
  _set(r, c, v, f) { this.cells.set(this._k(r, c), v); if (f) this.formules.set(this._k(r, c), f); else this.formules.delete(this._k(r, c)); }
  _get(r, c) { return this.cells.get(this._k(r, c)) ?? ""; }
  _getF(r, c) { return this.formules.get(this._k(r, c)) ?? ""; }
  getName() { return this.nom; }
  getLastRow() { let m = 0; for (const [k, v] of this.cells) if (v !== "" || this.formules.has(k)) m = Math.max(m, +k.split(":")[0]); return m; }
  getLastColumn() { let m = 0; for (const [k, v] of this.cells) if (v !== "") m = Math.max(m, +k.split(":")[1]); return m; }
  getMaxRows() { return 1000; }
  getRange(a, b, c = 1, d = 1) {
    if (typeof a === "string") {
      const m = a.match(/^([A-Z]+)(\d*)(?::([A-Z]+)(\d*))?$/);
      const c1 = colIndex(m[1]), r1 = m[2] ? +m[2] : 1;
      const c2 = m[3] ? colIndex(m[3]) : c1, r2 = m[4] ? +m[4] : (m[2] && !m[3] ? r1 : 1000);
      return new Plage(this, r1, c1, r2 - r1 + 1, c2 - c1 + 1);
    }
    return new Plage(this, a, b, c, d);
  }
  appendRow(v) { const r = this.getLastRow() + 1; v.forEach((x, j) => this._set(r, j + 1, x, null)); }
  setFrozenRows() {} setColumnWidth() {} setConditionalFormatRules() {}
}

class Classeur {
  constructor() { this.feuilles = [new Feuille("Feuille 1")]; }
  getSheetByName(n) { return this.feuilles.find((f) => f.nom === n) || null; }
  insertSheet(n) { const f = new Feuille(n); this.feuilles.push(f); return f; }
  getSheets() { return this.feuilles; }
  deleteSheet(f) { this.feuilles = this.feuilles.filter((x) => x !== f); }
  setActiveSheet() {} toast() {}
}

const chaine = () => new Proxy({}, { get: (_, p) => (p === "build" ? () => ({}) : () => chaine()) });

export function chargerAppsScript(chemin) {
  const classeur = new Classeur();
  const props = new Map();
  const alertes = [];
  const ctx = {
    console,
    SpreadsheetApp: {
      getActive: () => classeur,
      getUi: () => ({ alert: (m) => alertes.push(m), createMenu: () => chaine() }),
      newDataValidation: chaine, newConditionalFormatRule: chaine,
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props.get(k) ?? null, setProperty: (k, v) => props.set(k, v) }) },
    Utilities: { getUuid: () => crypto.randomUUID() },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: {
      MimeType: { JSON: "application/json" },
      createTextOutput: (t) => ({ contenu: t, setMimeType() { return this; } }),
    },
    UrlFetchApp: { fetch: () => { throw new Error("réseau indisponible dans les tests"); } },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(chemin, "utf8") + "\n;globalThis.__api={initialiser,doPost,doGet,nettoyer,lireConfig};", ctx);
  const api = ctx.__api;
  const post = (corps) => JSON.parse(api.doPost({ postData: { contents: JSON.stringify(corps) } }).contenu);
  return { api, classeur, props, alertes, post };
}
