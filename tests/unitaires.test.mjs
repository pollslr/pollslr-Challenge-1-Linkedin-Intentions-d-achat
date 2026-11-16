// node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as lib from "../extension/lib.js";
import { chargerAppsScript } from "./gas-mock.mjs";

const ici = path.dirname(fileURLToPath(import.meta.url));
const cfg = (brut = {}) => lib.normaliserConfig(brut);

// ---------------------------------------------------------------- lib.js
test("URL de recherche : guillemets et espaces encodés, tri et période", () => {
  const url = lib.construireUrlRecherche('"mission de conseil"', { tri: "date_posted", periode: "past-24h" });
  assert.equal(url, "https://www.linkedin.com/search/results/content/?datePosted=%22past-24h%22&keywords=%22mission%20de%20conseil%22&origin=FACETED_SEARCH&sortBy=%22date_posted%22");
  assert.ok(lib.construireUrlRecherche('"a" OR "b"', {}).includes("keywords=%22a%22%20OR%20%22b%22"));
});

test("Configuration : plafond absolu de 10/jour et bornes", () => {
  const c = cfg({ MAX_PAR_JOUR: "50", INTERVALLE_HEURES: "0", ALEA_MINUTES: "500", MAX_PAR_EXECUTION_MAX: "40" });
  assert.equal(c.maxParJour, 10);
  assert.equal(c.intervalleHeures, 1);
  assert.equal(c.aleaMinutes, 60);
  assert.equal(c.maxParExecMax, 5);
  assert.equal(cfg({ PERIODE: "aucun" }).periode, "");
  assert.equal(cfg({ PERIODE: "" }).periode, "past-24h");
  assert.equal(cfg({ CLIQUER_PLUS: "non" }).cliquerPlus, false);
  assert.deepEqual(cfg({ JOURS_ACTIFS: "1,2,7" }).joursActifs, [1, 2, 0]);
});

test("Fenêtre horaire et jours actifs", () => {
  const c = cfg({ FENETRE_DEBUT: "09:00", FENETRE_FIN: "19:00", JOURS_ACTIFS: "1,2,3,4,5" });
  assert.equal(lib.estDansFenetre(new Date(2026, 10, 16, 10, 0), c), true);   // lundi 10 h
  assert.equal(lib.estDansFenetre(new Date(2026, 10, 16, 4, 0), c), false);   // lundi 4 h
  assert.equal(lib.estDansFenetre(new Date(2026, 10, 16, 19, 0), c), false);  // borne de fin exclue
  assert.equal(lib.estDansFenetre(new Date(2026, 10, 15, 10, 0), c), false);  // dimanche
  assert.deepEqual(lib.prochainDebutFenetre(new Date(2026, 10, 20, 20, 0), c), new Date(2026, 10, 23, 9, 0)); // ven. soir → lundi
});

test("Prochaine échéance : X heures ± aléa, jamais hors fenêtre", () => {
  const c = cfg({ INTERVALLE_HEURES: "3", ALEA_MINUTES: "20" });
  const t0 = new Date(2026, 10, 16, 10, 0);
  for (let i = 0; i < 500; i++) {
    const t = lib.calculerProchaineExecution(t0, c);
    const ecart = (t - t0) / 60e3;
    assert.ok(ecart >= 160 && ecart <= 200, "écart " + ecart);
    assert.ok(lib.estDansFenetre(t, c));
  }
  const soir = new Date(2026, 10, 16, 17, 30); // 17 h 30 + 3 h → hors fenêtre → mardi 9 h–9 h 20
  for (let i = 0; i < 200; i++) {
    const t = lib.calculerProchaineExecution(soir, c);
    assert.equal(t.getDate(), 17);
    assert.ok(t.getHours() === 9 && t.getMinutes() <= 20);
  }
  const fin = cfg({ FIN_PLANIFICATION: "2026-11-16 12:00" });
  assert.equal(lib.calculerProchaineExecution(t0, fin), null);
});

test("Quota par exécution et plafond journalier", () => {
  const c = cfg();
  for (let i = 0; i < 100; i++) assert.ok([3, 4].includes(lib.quotaExecution(c, 0)));
  assert.equal(lib.quotaExecution(c, 9, () => 0.99), 1);
  assert.equal(lib.quotaExecution(c, 10), 0);
});

test("Rotation des mots-clés : le plus ancien d'abord", () => {
  const m = lib.choisirMotCle([
    { requete: "a", derniereExec: "2026-11-16T10:00:00Z" },
    { requete: "b", derniereExec: "" },
    { requete: "c", derniereExec: "2026-11-16T08:00:00Z" },
  ]);
  assert.equal(m.requete, "b");
  assert.equal(lib.choisirMotCle([]), null);
});

// ---------------------------------------------------------------- content.js
const ctxContenu = { window: {} };
vm.createContext(ctxContenu);
vm.runInContext(fs.readFileSync(path.join(ici, "../extension/content.js"), "utf8"), ctxContenu);
const V = ctxContenu.window.__veille;

test("Détection : URL de vérification, connexion, CAPTCHA, messages", () => {
  const base = { titre: "Recherche | LinkedIn", textesAlerte: [], publicationsPresentes: true };
  assert.equal(V.detecter({ ...base, url: "https://www.linkedin.com/checkpoint/challenge/xyz" }).type, "BLOCAGE");
  assert.equal(V.detecter({ ...base, url: "https://www.linkedin.com/login?session_redirect=x" }).type, "SESSION_EXPIREE");
  assert.equal(V.detecter({ ...base, url: "https://www.linkedin.com/authwall?x" }).type, "SESSION_EXPIREE");
  assert.equal(V.detecter({ ...base, url: "https://www.linkedin.com/search/results/content/", captchaPresent: true }).type, "BLOCAGE");
  assert.equal(V.detecter({ ...base, url: "https://www.linkedin.com/search/results/content/", textesAlerte: ["Votre compte a été restreint temporairement"] }).type, "BLOCAGE");
  assert.equal(V.detecter({ ...base, url: "https://www.linkedin.com/search/results/content/", textesAlerte: ["Vous avez atteint la limite d’utilisation commerciale"] }).type, "BLOCAGE");
  assert.equal(V.detecter({ ...base, url: "https://www.linkedin.com/search/results/content/" }), null);
  // un post qui parle de « vérification de sécurité » ne déclenche rien (il n'est pas dans une zone d'alerte)
  assert.equal(V.detecter({ ...base, url: "https://www.linkedin.com/search/results/content/", texteCorps: "vérification de sécurité" }), null);
  // page sans publications avec message de blocage dans le corps
  assert.equal(V.detecter({ ...base, publicationsPresentes: false, url: "https://www.linkedin.com/search/results/content/", texteCorps: "Too many requests" }).type, "BLOCAGE");
  assert.equal(V.detecter({ ...base, publicationsPresentes: false, url: "https://www.linkedin.com/x", titre: "LinkedIn : s'identifier", texteCorps: "" }).type, "SESSION_EXPIREE");
});

test("Compteurs et date relative", () => {
  assert.equal(V.parseCompteur("1 234"), 1234);
  assert.equal(V.parseCompteur("1 234 réactions"), 1234);
  assert.equal(V.parseCompteur("1,2 k"), 1200);
  assert.equal(V.parseCompteur("12K"), 12000);
  assert.equal(V.parseCompteur("3 commentaires"), 3);
  assert.equal(V.parseCompteur(""), 0);
  assert.equal(V.extraireDateRelative("5 h • Modifié • 🌐"), "5 h");
  assert.equal(V.extraireDateRelative("5 mois •"), "5 mois");
});

// ---------------------------------------------------------------- Code.gs
test("Apps Script : initialisation, jeton, configuration", () => {
  const g = chargerAppsScript(path.join(ici, "../apps-script/Code.gs"));
  g.api.initialiser();
  const jeton = g.props.get("JETON");
  assert.ok(jeton && jeton.length > 30);
  assert.ok(g.alertes[0].includes(jeton));
  assert.equal(g.post({ action: "config", jeton: "faux" }).ok, false);
  const conf = g.post({ action: "config", jeton });
  assert.equal(conf.ok, true);
  assert.equal(conf.parametres.FENETRE_DEBUT, "09:00");
  assert.equal(conf.motsCles.length, 10);
  assert.equal(conf.sel, g.props.get("SEL"));
  assert.deepEqual(conf.idsConnus, []);
});

test("Apps Script : ajout, déduplication, injection de formule, =AI()", () => {
  const g = chargerAppsScript(path.join(ici, "../apps-script/Code.gs"));
  g.api.initialiser();
  const jeton = g.props.get("JETON");
  const pub = (n, texte = "Nous cherchons un audit de sécurité") => ({
    id: "urn:li:activity:" + n, url: "https://www.linkedin.com/feed/update/urn:li:activity:" + n + "/",
    motCle: '"audit de sécurité"', dateRelative: "2 h", dateCollecte: new Date().toISOString(),
    auteurHache: "abc123", texte, reactions: 5, commentaires: 2, republications: 0,
  });
  let r = g.post({ action: "publications", jeton, publications: [pub(1), pub(2, "=HYPERLINK(\"http://x\")"), { id: "javascript:alert(1)" }] });
  assert.deepEqual([r.ajoutees, r.doublons, r.rejetees], [2, 0, 1]);
  r = g.post({ action: "publications", jeton, publications: [pub(1), pub(3)] });
  assert.deepEqual([r.ajoutees, r.doublons], [1, 1]);
  const sh = g.classeur.getSheetByName("Publications");
  assert.equal(sh.getLastRow(), 4);
  assert.equal(sh._get(3, 7), "'=HYPERLINK(\"http://x\")");
  assert.equal(sh._get(2, 17), "À traiter");
  const f = sh._getF(2, 11);
  assert.ok(f.startsWith('=IF(G2="","",AI("Tu es analyste commercial'));
  assert.ok(f.includes("Thèmes autorisés : Incident de sécurité"));
  assert.ok(sh._getF(2, 14).includes("SIGNAL"));
  assert.deepEqual(g.post({ action: "config", jeton }).idsConnus, ["urn:li:activity:1", "urn:li:activity:2", "urn:li:activity:3"]);

  r = g.post({ action: "journal", jeton, entrees: [{ date: new Date().toISOString(), declencheur: "manuel", motCle: '"audit de sécurité"', collectees: 3, statut: "OK", details: "test" }] });
  assert.equal(r.ok, true);
  assert.equal(g.classeur.getSheetByName("Journal").getLastRow(), 2);
  const conf = g.post({ action: "config", jeton });
  assert.ok(conf.motsCles[0].derniereExec, "dernière exécution mise à jour pour la rotation");
});
