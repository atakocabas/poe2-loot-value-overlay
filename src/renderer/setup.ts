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
  const clientTxtInput = document.getElementById("client-txt") as HTMLInputElement;
  const emailInput = document.getElementById("contact-email") as HTMLInputElement;
  const browseButton = document.getElementById("browse") as HTMLButtonElement;
  const saveButton = document.getElementById("save") as HTMLButtonElement;
  const detectNote = document.getElementById("detect-note") as HTMLDivElement;

  /**
   * Says where the prefilled path came from, or that there isn't one. Without this the field reads
   * as something the user already chose, and an empty one gives no hint that map detection is the
   * thing being turned off.
   */
  function showDetectionResult(detected: string | null, current: string): void {
    if (detected) {
      detectNote.textContent = "Found in your Steam library.";
      detectNote.className = "";
    } else if (current) {
      detectNote.textContent = "";
      detectNote.className = "";
    } else {
      detectNote.textContent =
        "No Steam install found — pick the file by hand, or leave this empty to skip map detection.";
      detectNote.className = "missing";
    }
  }

  async function load(): Promise<void> {
    const config = await window.poe2Setup.getConfig();
    leagueInput.value = config.league;
    clientTxtInput.value = config.clientTxtPath;
    emailInput.value = config.contactEmail;
    showDetectionResult(config.detectedClientTxtPath, config.clientTxtPath);

    // Reopened from the tray rather than shown on first run: the app is already up, and saving
    // restarts it (the league is read by three pricing clients that each captured it at startup).
    if (config.setupCompleted) saveButton.textContent = "Save & Restart";
  }

  browseButton.addEventListener("click", async () => {
    const chosen = await window.poe2Setup.browseClientTxt();
    if (!chosen) return;
    clientTxtInput.value = chosen;
    detectNote.textContent = "";
    detectNote.className = "";
  });

  saveButton.addEventListener("click", async () => {
    // The window closes itself once main has written the file; disabling avoids a second save
    // racing the first through that gap.
    saveButton.disabled = true;
    await window.poe2Setup.save({
      league: leagueInput.value,
      clientTxtPath: clientTxtInput.value,
      contactEmail: emailInput.value
    });
  });

  void load();
})();
