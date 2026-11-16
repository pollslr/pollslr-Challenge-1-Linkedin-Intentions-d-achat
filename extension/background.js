// background.js — service worker : planification, orchestration d'une exécution,
// file d'attente sans perte, arrêt automatique, journal.
import {
  normaliserConfig, construireUrlRecherche, estDansFenetre, calculerProchaineExecution,
  cleJour, quotaExecution, choisirMotCle,
} from "./lib.js";

const ALARME = "veille-execution";
const MAX_IDS = 5000;
const MAX_JOURNAL = 300;
const DELAI_CHARGEMENT = 45_000;
const DELAI_COLLECTE = 180_000;
const SESSIONS_EXPIREES_AVANT_SUSPENSION = 2;

// ---------------------------------------------------------------------------
// Stockage local (chrome.storage.local) — aucun identifiant LinkedIn n'y est mis
// ---------------------------------------------------------------------------
const lire = async (cle, def) => (await chrome.storage.local.get(cle))[cle] ?? def;
const ecrire = (obj) => chrome.storage.local.set(obj);

const ETAT_INITIAL = { planifActive: false, arret: null, prochaineExec: null, enCours: false, enCoursDepuis: 0, sessionsExpirees: 0 };
const etat = async () => ({ ...ETAT_INITIAL, ...(await lire("etat", {})) });
async function majEtat(patch) {
  const e = { ...(await etat()), ...patch };
  await ecrire({ etat: e });
  await majBadge(e);
  return e;
}
async function majBadge(e) {
  if (e.arret) { await chrome.action.setBadgeText({ text: "STOP" }); await chrome.action.setBadgeBackgroundColor({ color: "#C62828" }); }
  else if (e.enCours) { await chrome.action.setBadgeText({ text: "…" }); await chrome.action.setBadgeBackgroundColor({ color: "#1565C0" }); }
  else if (e.planifActive) { await chrome.action.setBadgeText({ text: "ON" }); await chrome.action.setBadgeBackgroundColor({ color: "#2E7D32" }); }
  else await chrome.action.setBadgeText({ text: "" });
}

const REGLAGES_DEFAUT = { urlWebhook: "", jeton: "", modeTest: false, urlTest: "http://localhost:8765/fixture-resultats.html" };
const reglages = async () => ({ ...REGLAGES_DEFAUT, ...(await lire("reglages", {})) });

// ---------------------------------------------------------------------------
// Journal (local + envoyé dans l'onglet « Journal » de la Sheet)
// ---------------------------------------------------------------------------
async function journaliser(entree) {
  const e = {
    date: new Date().toISOString(), declencheur: "", motCle: "", collectees: 0,
    statut: "INFO", details: "", prochaine: "", ...entree,
  };
  const j = await lire("journal", []);
  j.unshift(e);
  const f = await lire("journalAEnvoyer", []);
  f.push(e);
  await ecrire({ journal: j.slice(0, MAX_JOURNAL), journalAEnvoyer: f.slice(-500) });
  console.log("[Veille]", e.statut, e.motCle, e.details);
  return e;
}

// ---------------------------------------------------------------------------
// Webhook Google Apps Script (toujours en POST : le jeton ne passe pas dans l'URL)
// ---------------------------------------------------------------------------
async function fetchAvecDelai(url, options, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...options, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

async function appelerWebhook(corps) {
  const r = await reglages();
  if (!r.urlWebhook || !r.jeton) throw new Error("Webhook non configuré (page Options de l'extension)");
  const rep = await fetchAvecDelai(r.urlWebhook, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ ...corps, jeton: r.jeton }),
  }, 60_000);
  if (!rep.ok) throw new Error("Webhook HTTP " + rep.status);
  const txt = await rep.text();
  let json;
  try { json = JSON.parse(txt); } catch (_) { throw new Error("Réponse non JSON du webhook (URL /exec et accès « Tout le monde » ?)"); }
  if (!json.ok) throw new Error("Webhook : " + (json.erreur || "erreur inconnue"));
  return json;
}

async function ajouterIdsConnus(ids) {
  if (!ids || !ids.length) return;
  const set = new Set(await lire("idsConnus", []));
  ids.forEach((id) => set.add(id));
  await ecrire({ idsConnus: [...set].slice(-MAX_IDS) });
}

async function chargerConfig() {
  try {
    const rep = await appelerWebhook({ action: "config" });
    const cache = { brut: rep.parametres || {}, motsCles: rep.motsCles || [], sel: rep.sel || "", date: Date.now() };
    await ecrire({ cacheConfig: cache });
    await ajouterIdsConnus(rep.idsConnus || []);
    return { ...cache, cfg: normaliserConfig(cache.brut), source: "Sheet" };
  } catch (err) {
    const cache = await lire("cacheConfig", null);
    if (!cache) throw err;
    await journaliser({ statut: "ERREUR", details: "Sheet injoignable, dernière configuration connue utilisée : " + err.message });
    return { ...cache, cfg: normaliserConfig(cache.brut), source: "cache" };
  }
}

/** Envoie la file d'attente (publications + journal). Ne retire que ce qui a été accepté. */
async function viderFiles() {
  const pubs = await lire("fileAttente", []);
  let bilan = null;
  if (pubs.length) {
    bilan = await appelerWebhook({ action: "publications", publications: pubs });
    const envoyes = new Set(pubs.map((p) => p.id));
    await ecrire({ fileAttente: (await lire("fileAttente", [])).filter((p) => !envoyes.has(p.id)) });
  }
  const logs = await lire("journalAEnvoyer", []);
  if (logs.length) {
    await appelerWebhook({ action: "journal", entrees: logs });
    const dates = new Set(logs.map((l) => l.date + l.statut));
    await ecrire({ journalAEnvoyer: (await lire("journalAEnvoyer", [])).filter((l) => !dates.has(l.date + l.statut)) });
  }
  return bilan;
}

// ---------------------------------------------------------------------------
// Planification
// ---------------------------------------------------------------------------
async function planifierSuivante() {
  const cache = await lire("cacheConfig", null);
  const cfg = normaliserConfig(cache?.brut || {});
  const t = calculerProchaineExecution(new Date(), cfg);
  if (!t) { await desactiverPlanif("Fin de planification atteinte (FIN_PLANIFICATION)"); return null; }
  await chrome.alarms.create(ALARME, { when: t.getTime() });
  await majEtat({ prochaineExec: t.getTime() });
  return t;
}

async function activerPlanif() {
  const e = await etat();
  if (e.arret) throw new Error("Outil arrêté suite à un signal de détection : réarmez-le d'abord (manuellement).");
  await chargerConfig();
  await majEtat({ planifActive: true, sessionsExpirees: 0 });
  const t = await planifierSuivante();
  if (t) await journaliser({ declencheur: "manuel", statut: "PLANIFICATION ACTIVÉE", details: "Prochaine exécution programmée", prochaine: t.toISOString() });
  viderFiles().catch(() => {});
  return t;
}

async function desactiverPlanif(raison = "Désactivée manuellement") {
  await chrome.alarms.clear(ALARME);
  await majEtat({ planifActive: false, prochaineExec: null });
  await journaliser({ declencheur: "manuel", statut: "PLANIFICATION DÉSACTIVÉE", details: raison });
  viderFiles().catch(() => {});
}

/** Arrêt immédiat : plus d'alarme, plus d'exécution, réarmement manuel obligatoire. */
async function declencherArret(signal, { simulation = false, motCle = "" } = {}) {
  await chrome.alarms.clear(ALARME);
  await majEtat({ planifActive: false, prochaineExec: null, arret: { raison: signal, date: new Date().toISOString(), simulation } });
  await journaliser({
    declencheur: simulation ? "simulation" : "collecte", motCle, statut: "ARRÊT",
    details: (simulation ? "[SIMULATION] " : "") + "Signal de détection : " + signal +
      " — planification désactivée, aucun redémarrage automatique.",
  });
  viderFiles().catch(() => {});
}

// ---------------------------------------------------------------------------
// Une exécution = un seul chargement de la page de recherche
// ---------------------------------------------------------------------------
function attendreChargement(tabId, ms) {
  return new Promise((resolve) => {
    const fin = (r) => { clearTimeout(t); chrome.tabs.onUpdated.removeListener(ecoute); chrome.tabs.onRemoved.removeListener(ferme); resolve(r); };
    const ecoute = (id, info) => { if (id === tabId && info.status === "complete") fin({ ok: true }); };
    const ferme = (id) => { if (id === tabId) fin({ ok: false, raison: "Onglet fermé pendant le chargement" }); };
    const t = setTimeout(() => fin({ ok: false, raison: `Page non chargée après ${ms / 1000} s` }), ms);
    chrome.tabs.onUpdated.addListener(ecoute);
    chrome.tabs.onRemoved.addListener(ferme);
  });
}

const avecDelai = (promesse, ms, message) =>
  Promise.race([promesse, new Promise((_, rej) => setTimeout(() => rej(new Error(message)), ms))]);

const plusRecent = (a, b) => ((a ? Date.parse(a) || 0 : 0) >= (b ? Date.parse(b) || 0 : 0) ? a : b);

async function executer(declencheur) {
  const e0 = await etat();
  if (e0.arret) {
    await journaliser({ declencheur, statut: "REFUSÉ", details: `Outil arrêté (${e0.arret.raison}). Réarmement manuel requis.` });
    viderFiles().catch(() => {});
    return;
  }
  if (e0.enCours && Date.now() - e0.enCoursDepuis < 5 * 60e3) {
    await journaliser({ declencheur, statut: "IGNORÉ", details: "Une exécution est déjà en cours" });
    viderFiles().catch(() => {});
    return;
  }
  await majEtat({ enCours: true, enCoursDepuis: Date.now() });
  // garde le service worker éveillé pendant la collecte (MV3)
  const reveil = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20_000);
  const ctx = { declencheur, motCle: "", collectees: 0, statut: "OK", details: "" };
  let tabId = null;

  try {
    await viderFiles().catch((err) => journaliser({ declencheur, statut: "ERREUR", details: "Envoi différé impossible : " + err.message }));

    const conf = await chargerConfig();
    const cfg = conf.cfg;
    const maintenant = new Date();

    if (declencheur === "planifiée") {
      if (cfg.finPlanification && maintenant > cfg.finPlanification) {
        Object.assign(ctx, { statut: "FIN", details: "FIN_PLANIFICATION dépassée" });
        await desactiverPlanif("Fin de planification atteinte (FIN_PLANIFICATION)");
        return;
      }
      if (!estDansFenetre(maintenant, cfg)) {
        Object.assign(ctx, { statut: "HORS FENÊTRE", details: `Hors fenêtre ${cfg.fenetreDebut}–${cfg.fenetreFin} : rien n'est fait` });
        return;
      }
    }

    const compteurs = await lire("compteurs", {});
    const jour = cleJour(maintenant);
    const deja = compteurs[jour] || 0;
    const quota = quotaExecution(cfg, deja);
    if (quota <= 0) {
      Object.assign(ctx, { statut: "PLAFOND", details: `Plafond journalier atteint (${deja}/${cfg.maxParJour})` });
      return;
    }

    const local = await lire("derniersMotsCles", {});
    const mc = choisirMotCle(conf.motsCles.map((m) => ({ ...m, derniereExec: plusRecent(m.derniereExec, local[m.requete]) })));
    if (!mc) { Object.assign(ctx, { statut: "ERREUR", details: "Aucun mot-clé actif dans l'onglet « Mots-clés »" }); return; }
    ctx.motCle = mc.requete;

    const r = await reglages();
    const url = r.modeTest
      ? r.urlTest + (r.urlTest.includes("?") ? "&" : "?") + "keywords=" + encodeURIComponent(mc.requete)
      : construireUrlRecherche(mc.requete, cfg);

    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab.id;
    const charge = await attendreChargement(tabId, DELAI_CHARGEMENT);
    if (!charge.ok) { Object.assign(ctx, { statut: "PAGE INDISPONIBLE", details: charge.raison }); return; }

    const idsConnus = await lire("idsConnus", []);
    let result;
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      const [inj] = await avecDelai(chrome.scripting.executeScript({
        target: { tabId },
        func: (p) => window.__veille.collecter(p),
        args: [{
          quota, idsConnus, sel: conf.sel, cliquerPlus: cfg.cliquerPlus, tri: cfg.tri,
          pauseMinSec: cfg.pauseMinSec, pauseMaxSec: cfg.pauseMaxSec,
        }],
      }), DELAI_COLLECTE, "Collecte interrompue (délai dépassé)");
      result = inj && inj.result;
    } catch (err) {
      const msg = String(err.message || err);
      Object.assign(ctx, { statut: /error page|Cannot access|No tab/i.test(msg) ? "PAGE INDISPONIBLE" : "ERREUR", details: msg });
      return;
    }
    if (!result) { Object.assign(ctx, { statut: "ERREUR", details: "Aucun résultat renvoyé par la page" }); return; }

    // Sauvegarde locale AVANT l'envoi → aucune perte si la Sheet est injoignable
    const connus = new Set(idsConnus);
    const nouveaux = (result.posts || []).filter((p) => !connus.has(p.id)).map((p) => ({ ...p, motCle: mc.requete }));
    if (nouveaux.length) {
      await ecrire({
        fileAttente: [...(await lire("fileAttente", [])), ...nouveaux],
        compteurs: { ...compteurs, [jour]: deja + nouveaux.length },
      });
      await ajouterIdsConnus(nouveaux.map((p) => p.id));
    }
    ctx.collectees = nouveaux.length;
    await ecrire({ derniersMotsCles: { ...local, [mc.requete]: new Date().toISOString() } });

    if (result.statut === "BLOCAGE") {
      Object.assign(ctx, { statut: "BLOCAGE", details: result.signal + " → arrêt automatique" });
      await declencherArret(result.signal, { motCle: mc.requete });
    } else if (result.statut === "SESSION_EXPIREE") {
      const n = (await etat()).sessionsExpirees + 1;
      await majEtat({ sessionsExpirees: n });
      Object.assign(ctx, { statut: "SESSION EXPIRÉE", details: "Reconnectez-vous à LinkedIn dans ce navigateur. " + (result.signal || "") });
      if (n >= SESSIONS_EXPIREES_AVANT_SUSPENSION) await desactiverPlanif(`Session expirée ${n} fois de suite : planification suspendue`);
    } else {
      await majEtat({ sessionsExpirees: 0 });
      if (result.statut === "VIDE") Object.assign(ctx, { statut: "VIDE", details: result.details });
      else ctx.details = `${result.vus} publication(s) vue(s), ${result.ignoresConnus} déjà connue(s). ${result.details || ""}`.trim();
    }

    const bilan = await viderFiles().catch((err) => { ctx.details += " | Envoi vers la Sheet différé : " + err.message; return null; });
    if (bilan && bilan.doublons) ctx.details += ` | ${bilan.doublons} doublon(s) écarté(s) par la Sheet`;
  } catch (err) {
    Object.assign(ctx, { statut: "ERREUR", details: String(err.message || err) });
  } finally {
    clearInterval(reveil);
    if (tabId !== null) chrome.tabs.remove(tabId).catch(() => {});
    const e = await majEtat({ enCours: false });
    if (e.planifActive && !e.arret) await planifierSuivante().catch(() => {});
    const e2 = await etat();
    ctx.prochaine = e2.prochaineExec ? new Date(e2.prochaineExec).toISOString() : "";
    await journaliser(ctx);
    viderFiles().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Événements
// ---------------------------------------------------------------------------
chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARME) executer("planifiée"); });

chrome.runtime.onInstalled.addListener(async () => {
  const e = await majEtat({ enCours: false });
  if (!e.planifActive) await chrome.alarms.clear(ALARME);
});

chrome.runtime.onStartup.addListener(async () => {
  const e = await majEtat({ enCours: false });
  if (e.arret || !e.planifActive) { await chrome.alarms.clear(ALARME); return; }
  if (!(await chrome.alarms.get(ALARME))) await planifierSuivante();
});

async function statut() {
  const e = await etat();
  const compteurs = await lire("compteurs", {});
  const cache = await lire("cacheConfig", null);
  const r = await reglages();
  return {
    etat: e,
    alarme: (await chrome.alarms.get(ALARME)) || null,
    collecteesAujourdhui: compteurs[cleJour(new Date())] || 0,
    maxParJour: normaliserConfig(cache?.brut || {}).maxParJour,
    fileAttente: (await lire("fileAttente", [])).length,
    journal: (await lire("journal", [])).slice(0, 12),
    configure: !!(r.urlWebhook && r.jeton),
    modeTest: r.modeTest,
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, repondre) => {
  (async () => {
    switch (msg && msg.type) {
      case "STATUT": return statut();
      case "ACTIVER": { const t = await activerPlanif(); return { prochaine: t && t.getTime() }; }
      case "DESACTIVER": await desactiverPlanif(); return {};
      case "EXECUTER": executer("manuel"); return { lance: true };
      case "REARMER":
        await majEtat({ arret: null, sessionsExpirees: 0 });
        await journaliser({ declencheur: "manuel", statut: "RÉARMÉ", details: "Réarmement manuel. La planification reste désactivée tant qu'elle n'est pas réactivée." });
        return {};
      case "SIGNAL_DETECTION": // envoyé par la page de simulation
        await declencherArret(msg.signal || "signal simulé", { simulation: true });
        return {};
      case "TESTER_WEBHOOK": {
        const rep = await appelerWebhook({ action: "config" });
        return { motsCles: (rep.motsCles || []).length, ids: (rep.idsConnus || []).length };
      }
      case "VIDER_FILES": return { bilan: await viderFiles() };
      default: throw new Error("Message inconnu");
    }
  })().then((r) => repondre({ ok: true, ...r }), (err) => repondre({ ok: false, erreur: String(err.message || err) }));
  return true;
});
