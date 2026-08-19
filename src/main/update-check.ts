import { isNewerVersion } from "../shared/version";
import type { Settings } from "../shared/settings";

/** A release on GitHub newer than the one running, and the page to get it from. */
export interface AvailableUpdate {
  /** Bare, with the tag's leading `v` stripped — the surfaces print their own. */
  version: string;
  /** The release's own `html_url`, which is what `gh release create` produced. */
  url: string;
}

/** The two fields this reads out of GitHub's release object. Everything else is ignored. */
interface GithubRelease {
  tag_name?: unknown;
  html_url?: unknown;
}

/**
 * `/releases/latest` rather than `/releases`: that endpoint already excludes drafts and
 * prereleases, so there is no filtering to do here and no way for an unpublished draft to be
 * announced to every install. Hardcoded rather than derived from `package.json`'s `repository`
 * field — this is one string, and parsing a git URL to rebuild it would be more code than it saves.
 */
const RELEASES_API = "https://api.github.com/repos/atakocabas/poe2-loot-value-overlay/releases/latest";

/** Long enough for a slow connection, short enough that a hung socket doesn't hold the timer's slot. */
const REQUEST_TIMEOUT_MS = 10000;

/**
 * Asks GitHub whether a newer release exists, and reports it once.
 *
 * **It notifies and nothing else.** No download, no install, no `electron-updater` — see the
 * `updates` block in `shared/settings.ts` for why. What it produces is an `AvailableUpdate` that the
 * tray menu and the panel header both render as a link to the release page; updating remains the
 * user going to that page and running the new installer.
 */
export class UpdateChecker {
  private readonly settings: Settings;
  private readonly currentVersion: string;
  private readonly fetchImpl: typeof fetch;
  private readonly onUpdate: (update: AvailableUpdate) => void;
  private readonly userAgent: string;

  private timer: ReturnType<typeof setInterval> | null = null;
  private available: AvailableUpdate | null = null;
  /** The check already running, so a timer tick landing on one joins it instead of starting a second. */
  private inFlight: Promise<void> | null = null;

  constructor(deps: {
    settings: Settings;
    /** `app.getVersion()` — passed in rather than read here, so the tests need no Electron. */
    currentVersion: string;
    fetchImpl?: typeof fetch;
    onUpdate: (update: AvailableUpdate) => void;
  }) {
    this.settings = deps.settings;
    this.currentVersion = deps.currentVersion;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.onUpdate = deps.onUpdate;
    // GitHub rejects a request with no User-Agent outright, so this is required rather than polite.
    //
    // **Deliberately not `appUserAgent()`**, which the pricing clients share: that one appends
    // `trade2.contactEmail`, and it does so because GGG's developer policy asks a third-party client
    // to identify a contact. GitHub asked for no such thing, and reusing the string would put the
    // user's own address in a request to a service that never wanted it.
    this.userAgent = `PoE2LootValueOverlay/${deps.currentVersion}`;
  }

  /**
   * One check now, then one every `updates.checkIntervalMs`.
   *
   * Shaped like `CurrencyExchangeClient.startAutoRefresh()`: the disabled case logs and returns
   * rather than starting a timer that would check a flag it already knows the answer to.
   */
  start(): void {
    if (!this.settings.updates.checkForUpdates) {
      console.log("[update] disabled in settings");
      return;
    }
    void this.check();
    this.timer = setInterval(() => void this.check(), this.settings.updates.checkIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getAvailable(): AvailableUpdate | null {
    return this.available;
  }

  /**
   * Asks once, and never throws.
   *
   * Being offline, being behind a captive portal and having spent GitHub's unauthenticated hourly
   * budget are all the ordinary case, not faults — this runs unattended on a machine whose owner is
   * playing a game. It is called from the boot chain, whose `.catch` logs `[startup] failed`, so an
   * escaping rejection here would report the whole app as having failed to start.
   */
  async check(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.run().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async run(): Promise<void> {
    let release: GithubRelease;
    try {
      const response = await this.fetchImpl(RELEASES_API, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": this.userAgent },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      if (!response.ok) {
        console.log(`[update] check failed: HTTP ${response.status}`);
        return;
      }
      release = (await response.json()) as GithubRelease;
    } catch (error) {
      console.log(`[update] check failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    const tag = typeof release.tag_name === "string" ? release.tag_name : "";
    const url = typeof release.html_url === "string" ? release.html_url : "";
    if (!tag || !url) {
      console.log("[update] check failed: release has no tag or url");
      return;
    }

    if (!isNewerVersion(tag, this.currentVersion)) {
      console.log(`[update] up to date (running ${this.currentVersion}, latest ${tag})`);
      return;
    }

    const version = tag.replace(/^v/, "");
    // Only on a *change*: both surfaces hold their state, so re-reporting the same release every six
    // hours would rebuild the tray menu and push an OVERLAY_STATUS saying nothing new.
    if (this.available?.version === version) return;

    this.available = { version, url };
    console.log(`[update] v${version} available (running ${this.currentVersion})`);
    this.onUpdate(this.available);
  }
}
