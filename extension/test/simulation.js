document.getElementById("lancer").onclick = async () => {
  const sortie = document.getElementById("resultat");
  const analyse = window.__veille.analyserPage();
  sortie.textContent = "Résultat de la détection :\n" + JSON.stringify(analyse, null, 2);
  if (!analyse.blocage) { sortie.textContent += "\n\nAucun signal détecté (inattendu)."; return; }
  const r = await chrome.runtime.sendMessage({ type: "SIGNAL_DETECTION", signal: analyse.blocage.signal });
  const s = await chrome.runtime.sendMessage({ type: "STATUT" });
  sortie.textContent += "\n\nRéponse du service worker : " + (r.ok ? "arrêt enregistré" : r.erreur) +
    "\nPlanification active : " + s.etat.planifActive +
    "\nAlarme programmée : " + (s.alarme ? new Date(s.alarme.scheduledTime).toLocaleString("fr-FR") : "aucune") +
    "\nArrêt : " + JSON.stringify(s.etat.arret) +
    "\n\nOuvrez le popup : badge STOP, boutons désactivés, entrée ARRÊT dans le journal (et dans l'onglet Journal de la Sheet).";
};
