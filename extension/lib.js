// lib.js — fonctions pures (sans accès à Chrome) : construction d'URL,
// fenêtre horaire, calcul de la prochaine échéance, quotas.
// Testées par tests/lib.test.js (node).

// Plafond absolu imposé par l'exercice : quoi qu'on écrive dans la Sheet,
// l'outil ne collecte jamais plus de 10 publications par jour.
export const PLAFOND_ABSOLU_JOUR = 10;

export const DEFAUTS = {
  intervalleHeures: 3,      // une exécution toutes les X heures
  aleaMinutes: 20,          // ± décalage aléatoire autour de chaque échéance
  fenetreDebut: "09:00",    // pas d'exécution automatique avant…
  fenetreFin: "19:00",      // …ni après
  joursActifs: [1, 2, 3, 4, 5], // 0 = dimanche … 6 = samedi
  maxParJour: 10,
  maxParExecMin: 3,
  maxParExecMax: 4,
  periode: "past-24h",      // past-24h | past-week | past-month | "" (aucun filtre)
  tri: "date_posted",       // date_posted | relevance | ""
  cliquerPlus: true,
  pauseMinSec: 2,
  pauseMaxSec: 6,
  finPlanification: null,   // Date : au-delà, la planification s'éteint seule
};

const borne = (v, min, max) => Math.min(max, Math.max(min, v));
const nombre = (v, def) => {
  const n = Number(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) && String(v ?? "").trim() !== "" ? n : def;
};

/** "9:00", "09h30", "18" → minutes depuis minuit (ou null). */
export function parseHeure(txt) {
  const m = String(txt ?? "").trim().match(/^(\d{1,2})(?:[:hH](\d{2}))?$/);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2] ?? 0);
  if (h > 24 || mi > 59) return null;
  return h * 60 + mi;
}

/** "2026-11-16 17:30" ou "16/11/2026 17:30" → Date locale (ou null). */
export function parseDateHeure(txt) {
  const s = String(txt ?? "").trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})[ T](\d{1,2}):(\d{2})/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]);
  return null;
}

/**
 * Transforme le dictionnaire brut de l'onglet « Paramètres » (clé → texte)
 * en configuration typée, bornée et sûre.
 */
export function normaliserConfig(brut = {}) {
  const c = { ...DEFAUTS };
  c.intervalleHeures = borne(nombre(brut.INTERVALLE_HEURES, c.intervalleHeures), 1, 24);
  c.aleaMinutes = borne(nombre(brut.ALEA_MINUTES, c.aleaMinutes), 0, 60);
  if (parseHeure(brut.FENETRE_DEBUT) !== null) c.fenetreDebut = String(brut.FENETRE_DEBUT).trim();
  if (parseHeure(brut.FENETRE_FIN) !== null) c.fenetreFin = String(brut.FENETRE_FIN).trim();
  if (brut.JOURS_ACTIFS !== undefined && String(brut.JOURS_ACTIFS).trim() !== "") {
    const jours = String(brut.JOURS_ACTIFS).split(/[,;\s]+/).map(Number)
      .filter((j) => Number.isInteger(j) && j >= 0 && j <= 7).map((j) => j % 7);
    if (jours.length) c.joursActifs = [...new Set(jours)];
  }
  c.maxParJour = borne(Math.floor(nombre(brut.MAX_PAR_JOUR, c.maxParJour)), 0, PLAFOND_ABSOLU_JOUR);
  c.maxParExecMin = borne(Math.floor(nombre(brut.MAX_PAR_EXECUTION_MIN, c.maxParExecMin)), 1, 5);
  c.maxParExecMax = borne(Math.floor(nombre(brut.MAX_PAR_EXECUTION_MAX, c.maxParExecMax)), c.maxParExecMin, 5);
  // Valeurs acceptées ; « aucun » = pas de filtre, cellule vide = valeur par défaut.
  const choix = (v, permis) => {
    const s = String(v ?? "").trim();
    if (/^aucun$/i.test(s)) return "";
    return permis.includes(s) ? s : undefined;
  };
  const periode = choix(brut.PERIODE, ["past-24h", "past-week", "past-month"]);
  if (periode !== undefined) c.periode = periode;
  const tri = choix(brut.TRI, ["date_posted", "relevance"]);
  if (tri !== undefined) c.tri = tri;
  if (brut.CLIQUER_PLUS !== undefined) c.cliquerPlus = /^(oui|yes|vrai|true|1)$/i.test(String(brut.CLIQUER_PLUS).trim());
  c.pauseMinSec = borne(nombre(brut.PAUSE_MIN_SEC, c.pauseMinSec), 1, 30);
  c.pauseMaxSec = borne(nombre(brut.PAUSE_MAX_SEC, c.pauseMaxSec), c.pauseMinSec, 60);
  c.finPlanification = parseDateHeure(brut.FIN_PLANIFICATION);
  return c;
}

/**
 * URL de recherche de publications LinkedIn.
 * Paramètres observés en appliquant les filtres à la main puis en lisant l'URL :
 *   sortBy=%22date_posted%22   (tri « Plus récents »)
 *   datePosted=%22past-24h%22  (période « 24 dernières heures »)
 * Ils ne sont pas documentés : LinkedIn peut les changer à tout moment.
 */
export function construireUrlRecherche(motsCles, { tri = "", periode = "" } = {}) {
  const p = [];
  if (periode) p.push("datePosted=" + encodeURIComponent(JSON.stringify(periode)));
  p.push("keywords=" + encodeURIComponent(String(motsCles).trim()));
  p.push("origin=FACETED_SEARCH");
  if (tri) p.push("sortBy=" + encodeURIComponent(JSON.stringify(tri)));
  return "https://www.linkedin.com/search/results/content/?" + p.join("&");
}

/** La date est-elle dans la fenêtre horaire et un jour actif ? */
export function estDansFenetre(date, cfg) {
  if (!cfg.joursActifs.includes(date.getDay())) return false;
  const minutes = date.getHours() * 60 + date.getMinutes();
  return minutes >= parseHeure(cfg.fenetreDebut) && minutes < parseHeure(cfg.fenetreFin);
}

/** Prochain début de fenêtre strictement après `date` (jours actifs uniquement). */
export function prochainDebutFenetre(date, cfg) {
  const debut = parseHeure(cfg.fenetreDebut);
  for (let i = 0; i <= 8; i++) {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate() + i,
      Math.floor(debut / 60), debut % 60, 0, 0);
    if (d > date && cfg.joursActifs.includes(d.getDay())) return d;
  }
  return null;
}

/**
 * Prochaine échéance = maintenant + X heures ± aléa.
 * Si elle tombe hors fenêtre → début de la prochaine fenêtre + aléa (0…aléa).
 * Si elle dépasse FIN_PLANIFICATION → null (la planification s'arrête).
 */
export function calculerProchaineExecution(maintenant, cfg, aleatoire = Math.random) {
  const alea = cfg.aleaMinutes * 60e3;
  let t = new Date(maintenant.getTime() + cfg.intervalleHeures * 3600e3 + (aleatoire() * 2 - 1) * alea);
  if (!estDansFenetre(t, cfg)) {
    const debut = prochainDebutFenetre(t, cfg);
    if (!debut) return null;
    t = new Date(debut.getTime() + aleatoire() * alea);
  }
  if (t.getTime() < maintenant.getTime() + 60e3) t = new Date(maintenant.getTime() + 60e3);
  if (cfg.finPlanification && t > cfg.finPlanification) return null;
  return t;
}

export function cleJour(date) {
  const z = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${z(date.getMonth() + 1)}-${z(date.getDate())}`;
}

export function entierAleatoire(min, max, aleatoire = Math.random) {
  return min + Math.floor(aleatoire() * (max - min + 1));
}

/** Nombre de publications autorisées pour cette exécution (0 si plafond atteint). */
export function quotaExecution(cfg, dejaCollecteesAujourdhui, aleatoire = Math.random) {
  const restant = Math.max(0, Math.min(cfg.maxParJour, PLAFOND_ABSOLU_JOUR) - dejaCollecteesAujourdhui);
  return Math.min(entierAleatoire(cfg.maxParExecMin, cfg.maxParExecMax, aleatoire), restant);
}

/** Rotation : le mot-clé actif traité il y a le plus longtemps (jamais traité = prioritaire). */
export function choisirMotCle(motsCles) {
  const actifs = (motsCles || []).filter((m) => m && m.requete && String(m.requete).trim());
  if (!actifs.length) return null;
  const ts = (m) => (m.derniereExec ? new Date(m.derniereExec).getTime() || 0 : 0);
  return [...actifs].sort((a, b) => ts(a) - ts(b))[0];
}
