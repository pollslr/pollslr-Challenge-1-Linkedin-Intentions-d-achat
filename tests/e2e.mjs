// Test de bout en bout SANS LinkedIn : l'extension réelle est chargée dans Chromium,
// le « mode test » lui fait ouvrir des pages factices locales, et le webhook est
// le vrai Code.gs exécuté dans Node (gas-mock.mjs).
//   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node tests/e2e.mjs
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { chargerAppsScript } from "./gas-mock.mjs";

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); } catch { playwright = require("/opt/npm-tools/node_modules/playwright"); }

const ici = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(ici, "../extension");
const PORT = 8765;
const DOCS = path.join(ici, "../docs");

// ---- webhook (Code.gs) + pages factices
const gas = chargerAppsScript(path.join(ici, "../apps-script/Code.gs"));
gas.api.initialiser();
const jeton = gas.props.get("JETON");
const param = (cle, valeur) => {
  const sh = gas.classeur.getSheetByName("Paramètres");
  for (let r = 2; r <= sh.getLastRow(); r++) if (sh._get(r, 1) === cle) sh._set(r, 2, valeur, null);
};
param("PAUSE_MIN_SEC", "1");
param("PAUSE_MAX_SEC", "1");

const serveur = http.createServer((req, res) => {
  if (req.method === "POST" && req.url.startsWith("/exec")) {
    let corps = "";
    req.on("data", (c) => (corps += c));
    req.on("end", () => {
      const sortie = gas.api.doPost({ postData: { contents: corps } });
      res.writeHead(200, { "Content-Type": "application/json" }).end(sortie.contenu);
    });
    return;
  }
  const fichier = path.join(EXT, "test", path.basename(new URL(req.url, "http://x").pathname));
  if (!fs.existsSync(fichier)) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(fs.readFileSync(fichier));
});
await new Promise((r) => serveur.listen(PORT, r));

const profil = fs.mkdtempSync("/tmp/veille-profil-");
const ctx = await playwright.chromium.launchPersistentContext(profil, {
  headless: true, channel: "chromium", viewport: { width: 1100, height: 900 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
const extId = new URL(sw.url()).host;
console.log("Extension chargée :", extId);

const reglages = (r) => sw.evaluate((r) => chrome.storage.local.set({ reglages: r }), r);
await reglages({ urlWebhook: `http://localhost:${PORT}/exec`, jeton, modeTest: true, urlTest: `http://localhost:${PORT}/fixture-resultats.html` });

const popup = await ctx.newPage();
await popup.goto(`chrome-extension://${extId}/popup.html`);
const msg = (type) => popup.evaluate((type) => chrome.runtime.sendMessage({ type }), type);

async function executerEtAttendre(etiquette) {
  const avant = (await msg("STATUT")).journal.length ? (await msg("STATUT")).journal[0].date : "";
  await popup.click("#executer");
  for (let i = 0; i < 120; i++) {
    await popup.waitForTimeout(500);
    const s = await msg("STATUT");
    const fin = s.journal.find((l) => l.declencheur === "manuel" && l.date > avant && !/PLANIFICATION|RÉARMÉ/.test(l.statut));
    if (fin && !s.etat.enCours) { console.log(`  [${etiquette}] ${fin.statut} · ${fin.collectees} collectée(s) · ${fin.details}`); return { s, fin }; }
  }
  throw new Error("délai dépassé : " + etiquette);
}
const pubs = () => gas.classeur.getSheetByName("Publications");
const ligne = (r) => Array.from({ length: 17 }, (_, j) => pubs()._get(r, j + 1));

// 1. Première collecte (tri par date)
let { fin } = await executerEtAttendre("collecte 1");
assert.equal(fin.statut, "OK");
const n1 = pubs().getLastRow() - 1;
assert.ok(n1 === 3 || n1 === 4, "3 ou 4 publications par exécution, obtenu " + n1);
const l2 = ligne(2);
assert.equal(l2[0], "urn:li:activity:7390000000000000006");
assert.equal(l2[1], "https://www.linkedin.com/feed/update/urn:li:activity:7390000000000000006/");
assert.equal(l2[3], "2 h");
assert.match(l2[5], /^[0-9a-f]{20}$/);
assert.ok(!JSON.stringify(ligne(2)).includes("Marine"), "aucun nom en clair");
assert.ok(l2[6].includes("Windows 10"), "texte complet après clic sur « plus »");
assert.ok(!l2[6].includes("…plus"));
assert.deepEqual([l2[7], l2[8], l2[9]], [48, 23, 2]);
assert.equal(ligne(4)[7], 1234);
if (n1 === 4) assert.equal(ligne(5)[7], 1200);
assert.ok(pubs()._getF(2, 11).includes("AI("), "formule =AI() posée");

// 2. Même page, tri par date : le premier post est connu → arrêt immédiat, rien de nouveau
({ fin } = await executerEtAttendre("collecte 2 (dédup)"));
assert.equal(fin.collectees, 0);
assert.equal(pubs().getLastRow() - 1, n1);

// 3. Tri par pertinence : les connus sont sautés, les suivants collectés
param("TRI", "relevance");
({ fin } = await executerEtAttendre("collecte 3 (pertinence)"));
const n3 = pubs().getLastRow() - 1;
assert.ok(n3 > n1 && n3 <= 6);
const ids = Array.from({ length: n3 }, (_, i) => pubs()._get(i + 2, 1));
assert.equal(new Set(ids).size, ids.length, "aucun doublon");

// 4. Résultats vides
await reglages({ urlWebhook: `http://localhost:${PORT}/exec`, jeton, modeTest: true, urlTest: `http://localhost:${PORT}/fixture-vide.html` });
({ fin } = await executerEtAttendre("résultats vides"));
assert.equal(fin.statut, "VIDE");

// 5. Page indisponible (404 → aucun post, puis délai) : on teste plutôt une URL injoignable
await reglages({ urlWebhook: `http://localhost:${PORT}/exec`, jeton, modeTest: true, urlTest: `http://localhost:1/inexistant.html` });
({ fin } = await executerEtAttendre("page indisponible"));
assert.equal(fin.statut, "PAGE INDISPONIBLE");

// 6. Planification : activation → alarme + prochaine échéance affichée
await popup.click("#basculer");
await popup.waitForTimeout(800);
let s = await msg("STATUT");
assert.equal(s.etat.planifActive, true);
assert.ok(s.alarme && s.alarme.scheduledTime === s.etat.prochaineExec);
console.log("  [planification] prochaine exécution :", new Date(s.etat.prochaineExec).toString());
await popup.screenshot({ path: path.join(DOCS, "popup-planification.png"), clip: { x: 0, y: 0, width: 380, height: 600 } });

// 7. Page de vérification (CAPTCHA) → arrêt automatique, planification coupée, pas de relance
await reglages({ urlWebhook: `http://localhost:${PORT}/exec`, jeton, modeTest: true, urlTest: `http://localhost:${PORT}/fixture-checkpoint.html` });
({ fin } = await executerEtAttendre("CAPTCHA"));
assert.equal(fin.statut, "BLOCAGE");
s = await msg("STATUT");
assert.ok(s.etat.arret);
assert.equal(s.etat.planifActive, false);
assert.equal(s.alarme, null);
await popup.waitForTimeout(2500);
await popup.screenshot({ path: path.join(DOCS, "popup-arret.png"), clip: { x: 0, y: 0, width: 380, height: 720 } });
assert.equal(await popup.isDisabled("#executer"), true, "bouton Exécuter désactivé après un arrêt");
await msg("EXECUTER"); // même en forçant, l'exécution est refusée
await popup.waitForTimeout(800);
fin = (await msg("STATUT")).journal[0];
console.log(`  [après arrêt] ${fin.statut} · ${fin.details}`);
assert.equal(fin.statut, "REFUSÉ");
const journal = gas.classeur.getSheetByName("Journal");
const statuts = Array.from({ length: journal.getLastRow() - 1 }, (_, i) => journal._get(i + 2, 5));
assert.ok(statuts.includes("ARRÊT"), "arrêt journalisé dans la Sheet");

// 8. Réarmement manuel puis page de simulation
await msg("REARMER");
const sim = await ctx.newPage();
await sim.goto(`chrome-extension://${extId}/test/simulation-blocage.html`);
await sim.click("#lancer");
await sim.waitForTimeout(1000);
s = await msg("STATUT");
assert.equal(s.etat.arret.simulation, true);
await sim.screenshot({ path: path.join(DOCS, "simulation-arret.png"), fullPage: true });

console.log("\nPublications en base :", pubs().getLastRow() - 1, "· Compteur du jour :", s.collecteesAujourdhui, "· Entrées de journal (Sheet) :", journal.getLastRow() - 1);
console.log("Statuts journalisés :", [...new Set(statuts)].join(", "));
console.log("\n✔ Tous les scénarios de bout en bout sont passés.");
await ctx.close();
serveur.close();
