/**
 * Veille LinkedIn — webhook Google Apps Script + classification LLM
 * ------------------------------------------------------------------
 * À coller dans la Google Sheet : Extensions › Apps Script.
 * Puis : menu « Veille LinkedIn › 1. Initialiser le classeur », et déployer
 * en « Application Web » (voir README).
 *
 * Aucun secret dans ce fichier : le jeton d'accès, le sel de pseudonymisation
 * et l'éventuelle clé API Gemini sont dans les Propriétés du script.
 */

const ONGLETS = {
  PARAM: 'Paramètres', MOTS: 'Mots-clés', PUB: 'Publications',
  JOURNAL: 'Journal', CAT: 'Catégories', PROMPT: 'Prompt IA',
};

const ENTETES_PUB = [
  'ID publication', 'URL', 'Mot-clé', 'Date relative (affichée)', 'Date de collecte', 'Auteur (haché)',
  'Texte', 'Réactions', 'Commentaires', 'Republications', 'Analyse IA (brute)',
  'Thème', 'Intention', "Signal d'achat (0-5)", 'Justification', 'Résumé', 'Statut commercial',
];
const COL = { ID: 1, TEXTE: 7, BRUT: 11, THEME: 12, SIGNAL: 14, STATUT: 17 };
const ENTETES_JOURNAL = ['Date/heure', 'Déclencheur', 'Mot-clé', 'Publications collectées', 'Statut', 'Détails', 'Prochaine échéance'];

const PARAMETRES_DEFAUT = [
  ['INTERVALLE_HEURES', '3', 'Une exécution toutes les X heures (1 à 24).'],
  ['ALEA_MINUTES', '20', 'Décalage aléatoire ± autour de chaque échéance (0 à 60 min).'],
  ['FENETRE_DEBUT', '09:00', 'Aucune exécution automatique avant cette heure.'],
  ['FENETRE_FIN', '19:00', 'Aucune exécution automatique après cette heure.'],
  ['JOURS_ACTIFS', '1,2,3,4,5', 'Jours autorisés : 1 = lundi … 6 = samedi, 0 ou 7 = dimanche.'],
  ['MAX_PAR_JOUR', '10', 'Publications collectées par jour au maximum (plafonné à 10 par l’extension).'],
  ['MAX_PAR_EXECUTION_MIN', '3', 'Volume minimal par exécution.'],
  ['MAX_PAR_EXECUTION_MAX', '4', 'Volume maximal par exécution (tiré au hasard entre min et max).'],
  ['PERIODE', 'past-24h', 'Filtre de date LinkedIn : past-24h, past-week, past-month ou aucun.'],
  ['TRI', 'date_posted', 'Tri LinkedIn : date_posted (plus récents) ou relevance.'],
  ['CLIQUER_PLUS', 'OUI', 'OUI = déplie le texte tronqué (« plus ») des nouvelles publications uniquement.'],
  ['PAUSE_MIN_SEC', '2', 'Pause minimale entre deux actions (secondes).'],
  ['PAUSE_MAX_SEC', '6', 'Pause maximale entre deux actions (secondes).'],
  ['FIN_PLANIFICATION', '', 'Optionnel, ex. 2026-11-16 17:30 : la planification s’éteint seule après.'],
  ['CLASSIFICATION', 'AI', 'AI = formule =AI() de Google Sheets ; GEMINI = API Gemini (JSON) ; AUCUNE.'],
  ['MODELE_GEMINI', 'gemini-2.5-flash', 'Modèle utilisé si CLASSIFICATION = GEMINI.'],
];

const MOTS_CLES_DEFAUT = [
  ['"audit de sécurité"', 'Besoin explicite d’audit'],
  ['"test d\'intrusion" OR "pentest"', 'Besoin explicite de test'],
  ['"tentative de phishing" OR "victime de phishing"', 'Incident subi'],
  ['"rançongiciel" OR "ransomware"', 'Incident subi ou crainte'],
  ['"conformité NIS2" OR "directive NIS2"', 'Échéance réglementaire'],
  ['"recherche RSSI" OR "RSSI à temps partagé" OR "RSSI externalisé"', 'Manque de compétences internes'],
  ['"prestataire cybersécurité" OR "cabinet cybersécurité"', 'Recherche de prestataire'],
  ['"audit informatique"', 'Besoin d’audit (formulation PME)'],
  ['"migration Microsoft 365" OR "migration cloud"', 'Projet IT qui ouvre une fenêtre d’audit'],
  ['"cyberattaque" PME', 'Incident ou sensibilisation (à qualifier)'],
];

const THEMES_DEFAUT = [
  ['Incident de sécurité', "L'auteur ou son organisation a subi une attaque, une fraude ou une tentative (phishing, rançongiciel, fuite, usurpation).", "Besoin le plus urgent : après un incident, l'audit devient prioritaire et le budget se débloque."],
  ['Conformité & réglementation', 'NIS2, RGPD, ISO 27001, DORA, exigence d’un client, d’un donneur d’ordre ou d’un assureur cyber.', 'Une échéance réglementaire crée une obligation d’audit datée.'],
  ['Recherche d’audit / test d’intrusion', 'Demande ou projet explicite d’audit, de pentest, de diagnostic ou de cartographie des risques.', 'Correspond directement à l’offre : signal le plus qualifié.'],
  ['Projet IT / migration', 'Migration cloud ou Microsoft 365, refonte du SI, nouveaux serveurs, fusion de systèmes.', 'Un changement d’infrastructure crée des failles et justifie un audit de fin de projet.'],
  ['Recrutement cyber / IT', 'Recherche de RSSI, d’administrateur systèmes, de consultant sécurité ou de RSSI à temps partagé.', 'Révèle un manque de compétences internes qu’un audit externe peut combler.'],
  ['Veille & sensibilisation', 'Conseils, actualités, chiffres, retours d’expérience sans besoin exprimé.', 'Intérêt pour le sujet : utile pour un premier contact, pas de besoin immédiat.'],
  ['Promotion d’un prestataire', 'Un cabinet, éditeur ou consultant cyber fait la promotion de son offre.', 'Concurrent ou partenaire potentiel : à exclure de la prospection.'],
  ['Hors sujet', 'Sans lien avec la sécurité informatique ou l’IT.', 'Bruit de la recherche par mots-clés, à écarter.'],
];

const INTENTIONS_DEFAUT = [
  ['Demander de l’aide / une recommandation', 'Cherche un prestataire, un conseil, des retours.'],
  ['Témoigner d’une expérience', 'Raconte un incident, un projet, une leçon apprise.'],
  ['Annoncer un projet', 'Annonce une transformation, une certification, un chantier.'],
  ['Recruter', 'Publie une offre ou cherche un profil.'],
  ['Recueillir un avis', 'Sondage, question ouverte à son réseau.'],
  ['Informer / partager une veille', 'Article, chiffre, actualité, conseil général.'],
  ['Promouvoir une offre', 'Met en avant un produit ou un service.'],
  ['Autre', 'Aucune des intentions précédentes.'],
];

const CONSIGNES_DEFAUT =
  "Tu es analyste commercial pour un prestataire indépendant d'audit de cybersécurité qui propose aux PME et ETI " +
  "(notamment en Bretagne) des audits automatisés de postes et serveurs Windows/Linux, des tests d'intrusion et des " +
  "comptes rendus clairs pour les dirigeants. On te donne le texte d'une publication LinkedIn trouvée par recherche " +
  "de mots-clés. Classe-la pour décider si son auteur est un prospect.\n" +
  "Échelle du signal d'achat : 0 = aucun lien avec l'offre ou auteur concurrent ; 1 = sujet cyber général, simple veille ; " +
  "2 = contexte favorable sans besoin exprimé (projet IT, croissance, conformité évoquée) ; 3 = besoin probable (incident " +
  "subi, échéance réglementaire proche, recrutement cyber) ; 4 = besoin explicite (cherche un audit, un pentest, un " +
  "prestataire, des retours sur un cabinet) ; 5 = besoin explicite et urgent, ou appel d'offres en cours.\n" +
  "Règles : si l'auteur est lui-même un prestataire cyber qui fait sa promotion, le signal vaut 0 ou 1. " +
  "Justification : 15 mots maximum. Résumé : une phrase neutre, sans nommer de personne.";

const FORMAT_LIGNE =
  'Réponds UNIQUEMENT sur une seule ligne, exactement au format : ' +
  'THEME: <un thème autorisé> | INTENTION: <une intention autorisée> | SIGNAL: <entier de 0 à 5> | ' +
  'JUSTIFICATION: <15 mots max> | RESUME: <une phrase>';

// ===========================================================================
// Menu et initialisation
// ===========================================================================
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Veille LinkedIn')
    .addItem('1. Initialiser / réparer le classeur', 'initialiser')
    .addItem('Afficher le jeton d’accès', 'afficherJeton')
    .addItem('Régénérer le jeton d’accès', 'regenererJeton')
    .addSeparator()
    .addItem('Réappliquer =AI() aux lignes non classées', 'reappliquerAI')
    .addItem('Classer les lignes non classées (API Gemini)', 'classerNonClasseesGemini')
    .addItem('Enregistrer la clé API Gemini', 'enregistrerCleGemini')
    .addToUi();
}

function proprietes() { return PropertiesService.getScriptProperties(); }

function initialiser() {
  const ss = SpreadsheetApp.getActive();
  const props = proprietes();
  if (!props.getProperty('JETON')) props.setProperty('JETON', Utilities.getUuid() + Utilities.getUuid().slice(0, 8));
  if (!props.getProperty('SEL')) props.setProperty('SEL', Utilities.getUuid());

  // Paramètres (valeurs en texte brut pour que « 09:00 » ne devienne pas une heure)
  let sh = onglet(ss, ONGLETS.PARAM);
  if (sh.getLastRow() < 2) {
    sh.getRange(1, 1, 1, 3).setValues([['Paramètre', 'Valeur', 'Description']]);
    sh.getRange(2, 2, PARAMETRES_DEFAUT.length, 1).setNumberFormat('@');
    sh.getRange(2, 1, PARAMETRES_DEFAUT.length, 3).setValues(PARAMETRES_DEFAUT);
  } else {
    const existants = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getDisplayValues().map((r) => r[0]);
    PARAMETRES_DEFAUT.filter((p) => existants.indexOf(p[0]) < 0).forEach((p) => {
      sh.getRange(sh.getLastRow() + 1, 2).setNumberFormat('@');
      sh.appendRow(p);
    });
  }
  styliser(sh, [220, 160, 520]);
  sh.getRange('A:A').setFontWeight('bold');

  sh = onglet(ss, ONGLETS.MOTS);
  if (sh.getLastRow() < 2) {
    sh.getRange(1, 1, 1, 4).setValues([['Actif', 'Requête LinkedIn (syntaxe de la barre de recherche)', 'Signal visé', 'Dernière exécution']]);
    sh.getRange(2, 1, MOTS_CLES_DEFAUT.length, 3).setValues(MOTS_CLES_DEFAUT.map((m) => [true, m[0], m[1]]));
  }
  sh.getRange(2, 1, 50, 1).insertCheckboxes(); // 50 lignes de mots-clés possibles
  sh.getRange('D:D').setNumberFormat('dd/MM/yyyy HH:mm');
  styliser(sh, [60, 460, 300, 150]);

  sh = onglet(ss, ONGLETS.PUB);
  if (sh.getLastRow() < 1) sh.getRange(1, 1, 1, ENTETES_PUB.length).setValues([ENTETES_PUB]);
  styliser(sh, [170, 90, 160, 90, 120, 120, 420, 70, 80, 90, 200, 170, 170, 80, 220, 280, 120]);
  sh.getRange('G:G').setWrap(true);
  sh.getRange('E:E').setNumberFormat('dd/MM/yyyy HH:mm');
  const statut = SpreadsheetApp.newDataValidation().requireValueInList(['À traiter', 'Contacté', 'En discussion', 'Non pertinent'], true).build();
  sh.getRange(2, COL.STATUT, sh.getMaxRows() - 1, 1).setDataValidation(statut);
  const plage = sh.getRange(2, COL.SIGNAL, sh.getMaxRows() - 1, 1);
  sh.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThanOrEqualTo(4).setBackground('#c8e6c9').setBold(true).setRanges([plage]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenNumberEqualTo(3).setBackground('#fff3c4').setRanges([plage]).build(),
  ]);

  sh = onglet(ss, ONGLETS.JOURNAL);
  if (sh.getLastRow() < 1) sh.getRange(1, 1, 1, ENTETES_JOURNAL.length).setValues([ENTETES_JOURNAL]);
  styliser(sh, [140, 100, 300, 90, 150, 520, 140]);
  sh.getRange('A:A').setNumberFormat('dd/MM/yyyy HH:mm:ss');
  sh.getRange('G:G').setNumberFormat('dd/MM/yyyy HH:mm');

  sh = onglet(ss, ONGLETS.CAT);
  if (sh.getLastRow() < 2) {
    sh.getRange(1, 1, 1, 3).setValues([['Thème', 'Définition', 'Pourquoi cette catégorie (justification)']]);
    sh.getRange(2, 1, THEMES_DEFAUT.length, 3).setValues(THEMES_DEFAUT);
    sh.getRange(1, 5, 1, 2).setValues([['Intention', 'Définition']]);
    sh.getRange(2, 5, INTENTIONS_DEFAUT.length, 2).setValues(INTENTIONS_DEFAUT);
  }
  styliser(sh, [220, 380, 380, 30, 260, 300]);
  sh.getRange('A:F').setWrap(true);

  sh = onglet(ss, ONGLETS.PROMPT);
  if (!sh.getRange('A2').getValue()) {
    sh.getRange('A1').setValue('Consignes envoyées au LLM (modifiables). Les listes de thèmes et d’intentions sont ajoutées automatiquement depuis l’onglet « Catégories ».');
    sh.getRange('A2').setValue(CONSIGNES_DEFAUT);
  }
  sh.setColumnWidth(1, 900);
  sh.getRange('A2').setWrap(true).setVerticalAlignment('top');
  sh.getRange('A1').setFontWeight('bold');

  const feuille1 = ss.getSheetByName('Feuille 1') || ss.getSheetByName('Sheet1');
  if (feuille1 && feuille1.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(feuille1);
  ss.setActiveSheet(ss.getSheetByName(ONGLETS.PUB));
  afficherJeton();
}

function onglet(ss, nom) { return ss.getSheetByName(nom) || ss.insertSheet(nom); }

function styliser(sh, largeurs) {
  sh.setFrozenRows(1);
  const n = Math.max(sh.getLastColumn(), largeurs.length);
  sh.getRange(1, 1, 1, n).setFontWeight('bold').setBackground('#e8eaed');
  largeurs.forEach((l, i) => sh.setColumnWidth(i + 1, l));
}

function afficherJeton() {
  SpreadsheetApp.getUi().alert('Jeton d’accès à coller dans les Options de l’extension :\n\n' +
    proprietes().getProperty('JETON') + '\n\nNe le publiez pas (ni dans le code, ni dans la vidéo).');
}

function regenererJeton() {
  proprietes().setProperty('JETON', Utilities.getUuid() + Utilities.getUuid().slice(0, 8));
  afficherJeton();
}

function enregistrerCleGemini() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('Clé API Gemini', 'Collez votre clé (Google AI Studio). Elle est stockée dans les Propriétés du script, pas dans la feuille.', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() === ui.Button.OK && r.getResponseText().trim()) {
    proprietes().setProperty('GEMINI_API_KEY', r.getResponseText().trim());
    ui.alert('Clé enregistrée.');
  }
}

// ===========================================================================
// Webhook
// ===========================================================================
function doGet() {
  return ContentService.createTextOutput('Webhook Veille LinkedIn opérationnel (utiliser POST avec le jeton).');
}

function doPost(e) {
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const jeton = proprietes().getProperty('JETON');
    if (!jeton || req.jeton !== jeton) throw new Error('Jeton invalide');
    switch (req.action) {
      case 'config': return repondre(lireConfig());
      case 'publications': return repondre(enregistrerPublications(req.publications || []));
      case 'journal': return repondre(enregistrerJournal(req.entrees || []));
      default: throw new Error('Action inconnue');
    }
  } catch (err) {
    return repondre({ ok: false, erreur: String(err.message || err) });
  }
}

function repondre(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function lireParametres() {
  const sh = SpreadsheetApp.getActive().getSheetByName(ONGLETS.PARAM);
  const out = {};
  if (!sh || sh.getLastRow() < 2) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, 2).getDisplayValues().forEach((r) => { if (r[0]) out[r[0].trim()] = r[1].trim(); });
  return out;
}

function lireConfig() {
  const ss = SpreadsheetApp.getActive();
  const mots = ss.getSheetByName(ONGLETS.MOTS);
  const motsCles = [];
  if (mots && mots.getLastRow() >= 2) {
    mots.getRange(2, 1, mots.getLastRow() - 1, 4).getValues().forEach((r) => {
      if (r[0] === true && String(r[1]).trim()) {
        motsCles.push({ requete: String(r[1]).trim(), derniereExec: r[3] instanceof Date ? r[3].toISOString() : '' });
      }
    });
  }
  return {
    ok: true,
    parametres: lireParametres(),
    motsCles: motsCles,
    idsConnus: idsExistants().slice(-5000),
    sel: proprietes().getProperty('SEL') || '',
  };
}

function idsExistants() {
  const sh = SpreadsheetApp.getActive().getSheetByName(ONGLETS.PUB);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, COL.ID, sh.getLastRow() - 1, 1).getDisplayValues().map((r) => r[0]).filter(String);
}

/** Neutralise l'injection de formules : un post commençant par « = » ne doit pas s'exécuter. */
function nettoyer(v, max) {
  let s = String(v === undefined || v === null ? '' : v).slice(0, max || 45000);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return s;
}
const entier = (v) => Math.max(0, Math.floor(Number(v) || 0));

function enregistrerPublications(pubs) {
  const verrou = LockService.getScriptLock();
  verrou.waitLock(20000);
  try {
    const sh = SpreadsheetApp.getActive().getSheetByName(ONGLETS.PUB);
    const connus = {};
    idsExistants().forEach((id) => { connus[id] = true; });
    const lignes = [];
    let doublons = 0, rejetes = 0;
    pubs.forEach((p) => {
      const id = String(p.id || '');
      if (!/^(urn:li:(activity|share|ugcPost):\d+|h:[0-9a-f]{8,64})$/.test(id)) { rejetes++; return; }
      if (connus[id]) { doublons++; return; }
      connus[id] = true;
      const url = /^https:\/\/www\.linkedin\.com\//.test(String(p.url || '')) ? String(p.url) : '';
      const date = new Date(p.dateCollecte);
      lignes.push([
        id, url, nettoyer(p.motCle, 300), nettoyer(p.dateRelative, 40), isNaN(date) ? new Date() : date,
        nettoyer(p.auteurHache, 64), nettoyer(p.texte), entier(p.reactions), entier(p.commentaires), entier(p.republications),
      ]);
    });
    if (lignes.length) {
      const debut = sh.getLastRow() + 1;
      sh.getRange(debut, 1, lignes.length, 10).setValues(lignes);
      sh.getRange(debut, COL.STATUT, lignes.length, 1).setValue('À traiter');
      classer(sh, debut, lignes.length);
    }
    return { ok: true, ajoutees: lignes.length, doublons: doublons, rejetees: rejetes };
  } finally {
    verrou.releaseLock();
  }
}

function enregistrerJournal(entrees) {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(ONGLETS.JOURNAL);
  const d = (v) => { const x = new Date(v); return v && !isNaN(x) ? x : ''; };
  const lignes = entrees.slice(0, 500).map((e) => [
    d(e.date) || new Date(), nettoyer(e.declencheur, 30), nettoyer(e.motCle, 300), entier(e.collectees),
    nettoyer(e.statut, 40), nettoyer(e.details, 2000), d(e.prochaine),
  ]);
  if (lignes.length) sh.getRange(sh.getLastRow() + 1, 1, lignes.length, lignes[0].length).setValues(lignes);

  // Rotation des mots-clés : mémorise la dernière exécution de chaque requête
  const mots = ss.getSheetByName(ONGLETS.MOTS);
  if (mots && mots.getLastRow() >= 2) {
    const reqs = mots.getRange(2, 2, mots.getLastRow() - 1, 1).getDisplayValues().map((r) => r[0].trim());
    entrees.forEach((e) => {
      const i = reqs.indexOf(String(e.motCle || '').trim());
      if (i >= 0 && d(e.date)) mots.getRange(i + 2, 4).setValue(d(e.date));
    });
  }
  return { ok: true, ajoutees: lignes.length };
}

// ===========================================================================
// Classification par LLM
// ===========================================================================
function lireCategories() {
  const sh = SpreadsheetApp.getActive().getSheetByName(ONGLETS.CAT);
  const lire = (col) => sh.getRange(2, col, Math.max(sh.getLastRow() - 1, 1), 2).getDisplayValues().filter((r) => r[0].trim());
  return { themes: lire(1), intentions: lire(5) };
}

function construirePrompt(format) {
  const c = lireCategories();
  const consignes = String(SpreadsheetApp.getActive().getSheetByName(ONGLETS.PROMPT).getRange('A2').getValue() || CONSIGNES_DEFAUT);
  return consignes +
    '\nThèmes autorisés : ' + c.themes.map((t) => t[0] + ' (' + t[1] + ')').join(' ; ') +
    '\nIntentions autorisées : ' + c.intentions.map((t) => t[0] + ' (' + t[1] + ')').join(' ; ') +
    '\n' + format;
}

function classer(sh, debut, n) {
  const mode = (lireParametres().CLASSIFICATION || 'AI').toUpperCase();
  if (mode === 'AUCUNE') return;
  if (mode === 'GEMINI') {
    try { classerGemini(sh, debut, n); }
    catch (err) { sh.getRange(debut, COL.BRUT, n, 1).setValue('Erreur Gemini : ' + err.message); }
    return;
  }
  appliquerFormulesAI(sh, debut, n);
}

/** Colonne K : =AI(prompt; texte). Colonnes L à P : extraction des champs par expression régulière. */
function appliquerFormulesAI(sh, debut, n) {
  const prompt = construirePrompt(FORMAT_LIGNE).replace(/\s*\n\s*/g, ' ').replace(/"/g, '""');
  const extraire = (r, motif) => '=IFERROR(TRIM(REGEXEXTRACT(K' + r + ',"(?i)' + motif + '")),"")';
  const formules = [];
  for (let r = debut; r < debut + n; r++) {
    formules.push([
      '=IF(G' + r + '="","",AI("' + prompt + '",G' + r + '))',
      extraire(r, 'TH[EÈ]ME\\s*:\\s*([^|]+)'),
      extraire(r, 'INTENTION\\s*:\\s*([^|]+)'),
      '=IFERROR(VALUE(REGEXEXTRACT(K' + r + ',"(?i)SIGNAL\\s*:\\s*([0-5])")),"")',
      extraire(r, 'JUSTIFICATION\\s*:\\s*([^|]+)'),
      extraire(r, 'R[EÉ]SUM[EÉ]\\s*:\\s*(.+)$'),
    ]);
  }
  sh.getRange(debut, COL.BRUT, n, 6).setFormulas(formules);
}

function lignesNonClassees(sh) {
  if (sh.getLastRow() < 2) return [];
  const v = sh.getRange(2, 1, sh.getLastRow() - 1, COL.THEME).getDisplayValues();
  const out = [];
  v.forEach((r, i) => { if (r[COL.TEXTE - 1] && !r[COL.THEME - 1]) out.push(i + 2); });
  return out;
}

function reappliquerAI() {
  const sh = SpreadsheetApp.getActive().getSheetByName(ONGLETS.PUB);
  lignesNonClassees(sh).forEach((r) => appliquerFormulesAI(sh, r, 1));
}

function classerNonClasseesGemini() {
  const sh = SpreadsheetApp.getActive().getSheetByName(ONGLETS.PUB);
  const lignes = lignesNonClassees(sh);
  lignes.forEach((r) => classerGemini(sh, r, 1));
  SpreadsheetApp.getActive().toast(lignes.length + ' ligne(s) classée(s) via Gemini');
}

/** Sortie structurée garantie par un schéma JSON (responseSchema). */
function classerGemini(sh, debut, n) {
  const cle = proprietes().getProperty('GEMINI_API_KEY');
  if (!cle) throw new Error('clé API absente (menu Veille LinkedIn › Enregistrer la clé API Gemini)');
  const modele = lireParametres().MODELE_GEMINI || 'gemini-2.5-flash';
  const c = lireCategories();
  const prompt = construirePrompt('Réponds en JSON selon le schéma fourni.');
  const schema = {
    type: 'OBJECT',
    properties: {
      theme: { type: 'STRING', enum: c.themes.map((t) => t[0]) },
      intention: { type: 'STRING', enum: c.intentions.map((t) => t[0]) },
      signal_achat: { type: 'INTEGER', description: 'Entier de 0 à 5' },
      justification: { type: 'STRING' },
      resume: { type: 'STRING' },
    },
    required: ['theme', 'intention', 'signal_achat', 'justification', 'resume'],
    propertyOrdering: ['theme', 'intention', 'signal_achat', 'justification', 'resume'],
  };
  const textes = sh.getRange(debut, COL.TEXTE, n, 1).getValues();
  for (let i = 0; i < n; i++) {
    const texte = String(textes[i][0] || '');
    if (!texte) continue;
    const rep = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(modele) + ':generateContent', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': cle },
      muteHttpExceptions: true,
      payload: JSON.stringify({
        systemInstruction: { parts: [{ text: prompt }] },
        contents: [{ role: 'user', parts: [{ text: texte.slice(0, 8000) }] }],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: schema },
      }),
    });
    if (rep.getResponseCode() !== 200) throw new Error('HTTP ' + rep.getResponseCode() + ' ' + rep.getContentText().slice(0, 200));
    const brut = JSON.parse(rep.getContentText()).candidates[0].content.parts[0].text;
    const o = JSON.parse(brut);
    sh.getRange(debut + i, COL.BRUT, 1, 6).setValues([[
      nettoyer(brut, 5000), nettoyer(o.theme, 100), nettoyer(o.intention, 100),
      Math.min(5, entier(o.signal_achat)), nettoyer(o.justification, 300), nettoyer(o.resume, 500),
    ]]);
  }
}
