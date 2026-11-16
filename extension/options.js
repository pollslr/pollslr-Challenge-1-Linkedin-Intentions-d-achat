const $ = (id) => document.getElementById(id);
const DEFAUT = { urlWebhook: "", jeton: "", modeTest: false, urlTest: "http://localhost:8765/fixture-resultats.html" };

async function charger() {
  const { reglages = {} } = await chrome.storage.local.get("reglages");
  const r = { ...DEFAUT, ...reglages };
  $("urlWebhook").value = r.urlWebhook;
  $("jeton").value = r.jeton;
  $("modeTest").checked = r.modeTest;
  $("urlTest").value = r.urlTest;
}

async function enregistrer() {
  const url = $("urlWebhook").value.trim();
  if (url && !/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(url)) {
    $("msg").textContent = "⚠ L'URL doit être celle du déploiement Web App (https://script.google.com/macros/s/…/exec).";
    return false;
  }
  await chrome.storage.local.set({ reglages: {
    urlWebhook: url, jeton: $("jeton").value.trim(), modeTest: $("modeTest").checked, urlTest: $("urlTest").value.trim() || DEFAUT.urlTest,
  } });
  $("msg").textContent = "✔ Enregistré.";
  return true;
}

$("enregistrer").onclick = enregistrer;
$("tester").onclick = async () => {
  if (!(await enregistrer())) return;
  $("msg").textContent = "Test en cours…";
  const r = await chrome.runtime.sendMessage({ type: "TESTER_WEBHOOK" });
  $("msg").textContent = r.ok
    ? `✔ Connexion OK : ${r.motsCles} mot(s)-clé(s) actif(s), ${r.ids} publication(s) déjà en base.`
    : "⚠ " + r.erreur;
};
charger();
