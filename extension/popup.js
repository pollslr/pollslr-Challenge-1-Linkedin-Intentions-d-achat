const $ = (id) => document.getElementById(id);
const envoyer = (type, extra = {}) => chrome.runtime.sendMessage({ type, ...extra });
const fmt = (ts) => ts ? new Date(ts).toLocaleString("fr-FR", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
const echapper = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let planifActive = false;

async function rafraichir() {
  const s = await envoyer("STATUT");
  if (!s || !s.ok) { $("msg").textContent = s ? s.erreur : "Pas de réponse"; return; }
  const e = s.etat;
  planifActive = e.planifActive;

  $("alerteArret").hidden = !e.arret;
  if (e.arret) {
    $("raisonArret").textContent = (e.arret.simulation ? "[SIMULATION] " : "") + e.arret.raison;
    $("dateArret").textContent = "le " + fmt(e.arret.date);
  }
  $("nonConfigure").hidden = s.configure;
  $("ligneTest").hidden = !s.modeTest;

  const p = $("planif");
  p.className = "pastille " + (e.arret ? "stop" : e.planifActive ? "on" : "off");
  p.textContent = e.arret ? "ARRÊTÉE" : e.enCours ? "EN COURS…" : e.planifActive ? "ACTIVE" : "INACTIVE";
  $("prochaine").textContent = e.planifActive ? fmt(e.prochaineExec) : "—";
  $("compteur").textContent = `${s.collecteesAujourdhui} / ${s.maxParJour}`;
  $("file").textContent = s.fileAttente;

  $("basculer").textContent = e.planifActive ? "Désactiver la planification" : "Activer la planification";
  $("basculer").disabled = !!e.arret || !s.configure;
  $("executer").disabled = !!e.arret || e.enCours || !s.configure;

  $("journal").innerHTML = s.journal.map((l) =>
    `<div><b>${echapper(l.statut)}</b> · ${fmt(l.date)}${l.motCle ? " · <i>" + echapper(l.motCle) + "</i>" : ""}` +
    `${l.collectees ? " · " + l.collectees + " collectée(s)" : ""}<br><span class="discret">${echapper(l.details)}` +
    `${l.prochaine ? " — prochaine : " + fmt(l.prochaine) : ""}</span></div>`).join("") || '<span class="discret">Vide</span>';
}

async function action(type, message) {
  $("msg").textContent = message || "";
  const r = await envoyer(type);
  if (r && !r.ok) $("msg").textContent = "⚠ " + r.erreur;
  await rafraichir();
}

$("basculer").onclick = () => action(planifActive ? "DESACTIVER" : "ACTIVER", planifActive ? "Désactivation…" : "Activation…");
$("executer").onclick = () => action("EXECUTER", "Exécution lancée (onglet en arrière-plan, ~30 à 60 s)…");
$("rearmer").onclick = () => {
  if (confirm("Avez-vous vérifié votre compte LinkedIn (connexion manuelle, aucun avertissement) ? Le réarmement ne relance PAS la planification.")) action("REARMER");
};
$("simuler").onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("test/simulation-blocage.html") });
$("options").onclick = () => chrome.runtime.openOptionsPage();
$("lienOptions2").onclick = (ev) => { ev.preventDefault(); chrome.runtime.openOptionsPage(); };

rafraichir();
setInterval(rafraichir, 2000);
