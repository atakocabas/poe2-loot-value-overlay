/*
 * The first-run setup form.
 *
 * The whole body is an IIFE on purpose. The renderer has no bundler — every page loads compiled JS
 * as a plain <script> — so tsc treats common.ts, index.ts and this file as one shared global scope,
 * and any top-level name declared in two of them is a compile error (TS2451). Declaring nothing at
 * top level here means this page can never collide with the panel's, whatever either grows into.
 */
(() => {
  const leagueInput = document.getElementById("league") as HTMLInputElement;
  const emailInput = document.getElementById("contact-email") as HTMLInputElement;
  const saveButton = document.getElementById("save") as HTMLButtonElement;

  async function load(): Promise<void> {
    const config = await window.poe2Setup.getConfig();
    leagueInput.value = config.league;
    emailInput.value = config.contactEmail;

    // Reopened from the tray rather than shown on first run: the app is already up, and saving
    // restarts it (the league is read by three pricing clients that each captured it at startup).
    if (config.setupCompleted) saveButton.textContent = "Save & Restart";
  }

  saveButton.addEventListener("click", async () => {
    // The window closes itself once main has written the file; disabling avoids a second save
    // racing the first through that gap.
    saveButton.disabled = true;
    await window.poe2Setup.save({
      league: leagueInput.value,
      contactEmail: emailInput.value
    });
  });

  void load();
})();
