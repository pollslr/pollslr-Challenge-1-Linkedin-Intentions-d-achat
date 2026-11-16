// content.js — injecté par background.js UNIQUEMENT dans l'onglet de la page de
// résultats de recherche qu'il vient d'ouvrir. Il ne navigue vers aucune autre
// page : il lit la page, clique éventuellement sur « plus », défile au plus
// 2 fois, puis rend la main.
//
// Ce qui n'est jamais extrait : photos de profil, images, vidéos, nom en clair.
(() => {
  if (window.__veille) return;

  // ---------------------------------------------------------------------------
  // 1. Signaux de détection / blocage
  // ---------------------------------------------------------------------------
  const URL_BLOCAGE = [/\/checkpoint\//i, /\/challenge/i, /captcha/i, /security-verification/i];
  const URL_SESSION = [/\/login/i, /\/authwall/i, /\/uas\//i, /\/signup/i, /\/start\/join/i];

  // Recherchés dans le titre, les boîtes de dialogue, les alertes et les titres
  // de la page (jamais dans le texte des publications, pour éviter de s'arrêter
  // parce qu'un post parle de « vérification de sécurité »).
  const TEXTES_BLOCAGE = [
    "vérification de sécurité", "contrôle de sécurité", "vérification rapide de sécurité",
    "quick security check", "security verification", "security check",
    "activité inhabituelle", "activité suspecte", "unusual activity", "suspicious activity",
    "compte a été restreint", "compte restreint", "temporairement restreint",
    "account has been restricted", "account restricted", "temporarily restricted",
    "limite d'utilisation commerciale", "commercial use limit", "limite de recherche",
    "trop de requêtes", "too many requests",
    "je ne suis pas un robot", "not a robot", "êtes un humain", "you're a human", "are human",
    "logiciels tiers", "third-party software", "outils d'automatisation", "automation tools",
  ];
  const TITRE_CONNEXION = /(s'identifier|se connecter|connexion|sign in|log in|login)/i;

  const SEL = {
    captcha: [
      'iframe[src*="captcha" i]', 'iframe[src*="arkose" i]', 'iframe[src*="funcaptcha" i]',
      'iframe[src*="recaptcha" i]', '#captcha-internal', '[id*="captcha" i]', 'form[action*="checkpoint" i]',
    ],
    zonesAlerte: [
      '[role="alertdialog"]', '[role="dialog"]', '[role="alert"]', ".artdeco-modal",
      "main h1", "main h2", ".artdeco-inline-feedback--error",
    ],
    formulaireConnexion: ['form[action*="login" i] input[type="password"]', "input#password", 'input[name="session_password"]'],
    aucunResultat: [".search-reusable-search-no-results", ".search-no-results", ".artdeco-empty-state"],

    // Sélecteurs de la page de résultats (fragiles : LinkedIn les change sans prévenir)
    publication: [
      'div[data-urn^="urn:li:activity:"]', 'div[data-urn^="urn:li:share:"]', 'div[data-urn^="urn:li:ugcPost:"]',
      '[data-chameleon-result-urn^="urn:li:activity:"]', "div.feed-shared-update-v2",
    ],
    auteurNom: [
      '.update-components-actor__title span[aria-hidden="true"]', '.update-components-actor__name span[aria-hidden="true"]',
      ".update-components-actor__title", ".update-components-actor__name", ".feed-shared-actor__name",
    ],
    auteurLien: [
      "a.update-components-actor__meta-link", "a.update-components-actor__image",
      ".update-components-actor a[href]", ".feed-shared-actor a[href]", 'a[href*="/in/"]', 'a[href*="/company/"]',
    ],
    dateRelative: [
      '.update-components-actor__sub-description span[aria-hidden="true"]', ".update-components-actor__sub-description",
      ".feed-shared-actor__sub-description", "time",
    ],
    texte: [
      ".update-components-text", ".feed-shared-inline-show-more-text", ".feed-shared-update-v2__description",
      ".feed-shared-text", '[data-test-id="main-feed-activity-card__commentary"]',
    ],
    boutonPlus: [
      "button.feed-shared-inline-show-more-text__see-more-less-toggle", ".feed-shared-inline-show-more-text__button",
      "button.see-more", 'button[aria-label*="plus" i]', 'button[aria-label*="see more" i]',
    ],
    zoneCompteurs: [".social-details-social-counts", ".update-v2-social-activity", ".social-details-social-activity"],
    reactions: [
      ".social-details-social-counts__reactions-count", 'button[aria-label*="réaction" i]',
      'button[aria-label*="reaction" i]', ".social-details-social-counts__social-proof-fallback-number",
    ],
    commentaires: [
      'button[aria-label*="commentaire" i]', 'button[aria-label*="comment" i]', ".social-details-social-counts__comments",
    ],
    republications: [
      'button[aria-label*="republication" i]', 'button[aria-label*="repost" i]', ".social-details-social-counts__item--right-aligned",
    ],
  };

  const normaliser = (s) => String(s || "").replace(/[’`]/g, "'").replace(/\s+/g, " ").toLowerCase();

  /**
   * Décision pure (testable sans navigateur) à partir d'informations sur la page.
   * Renvoie null, ou { type: "BLOCAGE" | "SESSION_EXPIREE", signal }.
   */
  function detecter(info) {
    const url = String(info.url || "");
    let chemin = url;
    try { const u = new URL(url); chemin = u.pathname + u.search; } catch (_) { /* url relative */ }
    for (const re of URL_BLOCAGE) if (re.test(chemin)) return { type: "BLOCAGE", signal: "Page de vérification : " + chemin.slice(0, 80) };
    for (const re of URL_SESSION) if (re.test(chemin)) return { type: "SESSION_EXPIREE", signal: "Redirection vers la connexion : " + chemin.slice(0, 80) };
    if (info.captchaPresent) return { type: "BLOCAGE", signal: "CAPTCHA présent dans la page" };
    const zones = normaliser([info.titre, ...(info.textesAlerte || [])].join(" | "));
    const trouve = TEXTES_BLOCAGE.find((t) => zones.includes(t));
    if (trouve) return { type: "BLOCAGE", signal: "Message de la plateforme : « " + trouve + " »" };
    if (!info.publicationsPresentes) {
      const corps = normaliser(info.texteCorps);
      const t2 = TEXTES_BLOCAGE.find((t) => corps.includes(t));
      if (t2) return { type: "BLOCAGE", signal: "Message de la plateforme : « " + t2 + " »" };
      if (info.formulaireConnexion || TITRE_CONNEXION.test(info.titre || "")) {
        return { type: "SESSION_EXPIREE", signal: "Formulaire de connexion affiché" };
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // 2. Outils DOM
  // ---------------------------------------------------------------------------
  const essayer = (fn) => { try { return fn(); } catch (_) { return null; } };
  const premier = (racine, sels) => {
    for (const s of sels) { const el = essayer(() => racine.querySelector(s)); if (el) return el; }
    return null;
  };
  const tous = (racine, sels) => {
    const out = [];
    for (const s of sels) { const l = essayer(() => racine.querySelectorAll(s)); if (l) out.push(...l); }
    return out;
  };
  const texteDe = (el) => (el ? String(el.innerText ?? el.textContent ?? "").replace(/[ \t]+\n/g, "\n").trim() : "");
  const attendre = (ms) => new Promise((r) => setTimeout(r, ms));
  const pause = (p) => attendre(1000 * (p.pauseMinSec + Math.random() * (p.pauseMaxSec - p.pauseMinSec)));

  async function sha256(txt) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(txt));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  /** « 1 234 », « 1,2 k », « 12K », « 3 commentaires » → nombre. */
  function parseCompteur(txt) {
    if (!txt) return 0;
    const m = String(txt).replace(/[  ]/g, " ").match(/(\d+(?:[ .,]\d{3})*(?:[.,]\d+)?)\s*([kKmM])?(?![a-zA-Z])/);
    if (!m) return 0;
    if (m[2]) {
      const n = parseFloat(m[1].replace(/\s/g, "").replace(",", "."));
      return Math.round(n * (/k/i.test(m[2]) ? 1e3 : 1e6));
    }
    return parseInt(m[1].replace(/[ .,]/g, ""), 10) || 0;
  }

  /** « 5 h • Modifié • 🌐 » → « 5 h » */
  function extraireDateRelative(txt) {
    const premierMorceau = String(txt || "").split(/[•·]/)[0].replace(/\s+/g, " ").trim();
    return premierMorceau.slice(0, 40);
  }

  // ---------------------------------------------------------------------------
  // 3. Analyse de la page
  // ---------------------------------------------------------------------------
  function trouverPublications() {
    const candidats = [...new Set(tous(document, SEL.publication))];
    // garder les conteneurs les plus externes (un post = un élément)
    return candidats.filter((el) => !candidats.some((autre) => autre !== el && autre.contains(el)));
  }

  function analyserPage() {
    const publications = trouverPublications();
    const dansUnPost = (el) => publications.some((p) => p.contains(el));
    const textesAlerte = tous(document, SEL.zonesAlerte).filter((el) => !dansUnPost(el)).map((el) => texteDe(el).slice(0, 500));
    const info = {
      url: location.href,
      titre: document.title,
      textesAlerte,
      captchaPresent: tous(document, SEL.captcha).length > 0,
      formulaireConnexion: !!premier(document, SEL.formulaireConnexion),
      publicationsPresentes: publications.length > 0,
      texteCorps: publications.length ? "" : texteDe(document.body).slice(0, 5000),
    };
    return {
      blocage: detecter(info),
      nbPublications: publications.length,
      aucunResultat: !publications.length && !!premier(document, SEL.aucunResultat),
    };
  }

  function idPublication(el) {
    const re = /urn:li:(?:activity|share|ugcPost):\d+/;
    const sources = [
      el.getAttribute("data-urn"), el.getAttribute("data-chameleon-result-urn"),
      el.querySelector("[data-urn]")?.getAttribute("data-urn"),
      el.closest("[data-urn]")?.getAttribute("data-urn"),
      el.querySelector('a[href*="/feed/update/"]')?.getAttribute("href"),
    ];
    for (const s of sources) { const m = s && decodeURIComponent(s).match(re); if (m) return m[0]; }
    return null;
  }

  function cleAuteur(el) {
    const lien = premier(el, SEL.auteurLien);
    if (lien) {
      const chemin = essayer(() => new URL(lien.getAttribute("href"), location.href).pathname);
      if (chemin && /\/(in|company|school|showcase)\//.test(chemin)) return chemin.replace(/\/+$/, "");
    }
    return texteDe(premier(el, SEL.auteurNom)).split("\n")[0];
  }

  function texteDuPost(el) {
    return texteDe(premier(el, SEL.texte))
      .replace(/…\s*(voir plus|plus|see more|more)\s*$/i, "")
      .trim();
  }

  function boutonPlus(el) {
    const zone = premier(el, SEL.texte) || el;
    const candidats = [...tous(zone, SEL.boutonPlus), ...tous(zone, ["button"])];
    return candidats.find((b) => {
      const t = normaliser(b.innerText || b.textContent || b.getAttribute("aria-label"));
      return /(^|…|\s)(voir plus|plus|see more|more)$/.test(t.trim()) && !/moins|less/.test(t);
    }) || null;
  }

  function compteur(el, sels) {
    const zone = premier(el, SEL.zoneCompteurs) || el;
    for (const c of tous(zone, sels)) {
      for (const t of [texteDe(c), c.getAttribute("aria-label")]) if (t && /\d/.test(t)) return parseCompteur(t);
    }
    return 0;
  }

  async function extraire(el, id, sel) {
    const urlPost = id.startsWith("urn:")
      ? `https://www.linkedin.com/feed/update/${id}/`
      : (essayer(() => new URL(el.querySelector('a[href*="/feed/update/"]').getAttribute("href"), location.href).href) || "");
    return {
      id,
      url: urlPost,
      dateRelative: extraireDateRelative(texteDe(premier(el, SEL.dateRelative))),
      dateCollecte: new Date().toISOString(),
      // pseudonymisation dès la collecte : seul le haché salé quitte la page
      auteurHache: (await sha256(sel + "|" + cleAuteur(el))).slice(0, 20),
      texte: texteDuPost(el).slice(0, 20000),
      reactions: compteur(el, SEL.reactions),
      commentaires: compteur(el, SEL.commentaires),
      republications: compteur(el, SEL.republications),
    };
  }

  // ---------------------------------------------------------------------------
  // 4. Collecte
  // ---------------------------------------------------------------------------
  /**
   * p = { quota, idsConnus, sel, cliquerPlus, tri, pauseMinSec, pauseMaxSec }
   * Renvoie { statut: OK | VIDE | BLOCAGE | SESSION_EXPIREE, posts, signal, details, vus, ignoresConnus }
   */
  async function collecter(p) {
    const res = { statut: "OK", posts: [], signal: null, details: "", vus: 0, ignoresConnus: 0 };
    const connus = new Set(p.idsConnus || []);
    const sel = p.sel || "";
    const arreter = (b) => Object.assign(res, { statut: b.type, signal: b.signal });

    await pause(p);
    const t0 = Date.now();
    for (;;) {
      const a = analyserPage();
      if (a.blocage) return arreter(a.blocage);
      if (a.nbPublications > 0) break;
      if (a.aucunResultat) return Object.assign(res, { statut: "VIDE", details: "Aucun résultat pour cette recherche" });
      if (Date.now() - t0 > 20000) {
        return Object.assign(res, { statut: "VIDE", details: "Aucune publication détectée après 20 s (résultats vides ou sélecteurs obsolètes)" });
      }
      await attendre(1000);
    }

    const traites = new Set();
    let defilements = 0;
    let fini = false;
    while (!fini && res.posts.length < p.quota) {
      for (const el of trouverPublications()) {
        if (res.posts.length >= p.quota) break;
        const id = idPublication(el) || "h:" + (await sha256(cleAuteur(el) + "|" + texteDuPost(el).slice(0, 300))).slice(0, 24);
        if (traites.has(id)) continue;
        traites.add(id);
        res.vus++;
        // Déduplication AVANT toute interaction (pas de clic « plus » sur un post connu)
        if (connus.has(id)) {
          res.ignoresConnus++;
          // trié par date : tout ce qui suit est plus ancien → on s'arrête là
          if (p.tri === "date_posted") { fini = true; break; }
          continue;
        }
        const avant = analyserPage();
        if (avant.blocage) return arreter(avant.blocage);
        if (p.cliquerPlus) {
          const b = boutonPlus(el);
          if (b) { await pause(p); b.click(); await attendre(600 + Math.random() * 900); }
        }
        res.posts.push(await extraire(el, id, sel));
        await pause(p);
      }
      if (fini || res.posts.length >= p.quota || defilements >= 2) break;
      defilements++;
      window.scrollBy({ top: Math.round(window.innerHeight * (0.6 + Math.random() * 0.3)), behavior: "smooth" });
      await pause(p);
      const apres = analyserPage();
      if (apres.blocage) return arreter(apres.blocage);
    }
    const fin = analyserPage();
    if (fin.blocage) return arreter(fin.blocage);
    if (!res.posts.length && res.ignoresConnus) res.details = "Aucune nouvelle publication (déjà collectées)";
    return res;
  }

  window.__veille = { version: "1.0.0", collecter, analyserPage, detecter, parseCompteur, extraireDateRelative };
})();
