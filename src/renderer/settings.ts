/*
 * The settings window: hotkeys, overlay behaviour, display currency and the trade search filters.
 *
 * The whole body is an IIFE on purpose, exactly as in setup.ts. The renderer has no bundler — every
 * page loads compiled JS as a plain <script> — so tsc treats common.ts, index.ts, setup.ts and this
 * file as one shared global scope, and any top-level name declared in two of them is a compile error
 * (TS2451). Declaring nothing at top level here means this page can never collide with the panel's.
 */
(() => {
  type HotkeyName = "toggleList" | "forceCapture";

  const HOTKEY_NAMES: HotkeyName[] = ["toggleList", "forceCapture"];

  const statusEl = document.getElementById("status") as HTMLDivElement;
  const saveButton = document.getElementById("save") as HTMLButtonElement;
  const hideUnfocusedInput = document.getElementById("hide-unfocused") as HTMLInputElement;
  const hideDelayInput = document.getElementById("hide-delay") as HTMLInputElement;
  const panelWidthInput = document.getElementById("panel-width") as HTMLInputElement;
  const panelHeightInput = document.getElementById("panel-height") as HTMLInputElement;
  const panelPositionSelect = document.getElementById("panel-position") as HTMLSelectElement;
  const currencySelect = document.getElementById("currency") as HTMLSelectElement;
  const listingStatusSelect = document.getElementById("listing-status") as HTMLSelectElement;
  const saleTypeSelect = document.getElementById("sale-type") as HTMLSelectElement;
  const useMapFiltersInput = document.getElementById("use-map-filters") as HTMLInputElement;
  const mapRatioInput = document.getElementById("map-min-ratio") as HTMLInputElement;

  /** Working copy of the hotkeys. The recorder edits this; Save sends it. */
  const hotkeys: Record<HotkeyName, string> = {
    toggleList: "",
    forceCapture: ""
  };
  let defaults: SettingsConfig | null = null;
  /** What the fields were last filled from — the fallback when one is left empty. */
  let loaded: SettingsConfig | null = null;
  /** Which recorder is listening, or null. Only ever one at a time. */
  let recording: HotkeyName | null = null;

  /*
   * `e.code` rather than `e.key`, so a combination records as the key you pressed rather than the
   * character it produced: Shift+2 is "2", not "@", and a letter is the same whether or not Caps
   * Lock is on. The names on the right are Electron's, which is what settings.json stores.
   *
   * Only what a physical keyboard can send; main re-validates whatever arrives, so a gap here shows
   * up as "that isn't a key" rather than as a hotkey that silently never binds.
   */
  const CODE_TO_KEY: Record<string, string> = {
    Space: "Space",
    Tab: "Tab",
    Enter: "Return",
    NumpadEnter: "Return",
    Backspace: "Backspace",
    Delete: "Delete",
    Insert: "Insert",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    Escape: "Escape",
    CapsLock: "Capslock",
    NumLock: "Numlock",
    ScrollLock: "Scrolllock",
    PrintScreen: "PrintScreen",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Backquote: "`",
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/",
    NumpadDecimal: "numdec",
    NumpadAdd: "numadd",
    NumpadSubtract: "numsub",
    NumpadMultiply: "nummult",
    NumpadDivide: "numdiv"
  };

  /** How each Electron modifier spelling reads on Windows. */
  const MODIFIER_LABELS: Record<string, string> = {
    commandorcontrol: "Ctrl",
    cmdorctrl: "Ctrl",
    control: "Ctrl",
    ctrl: "Ctrl",
    command: "Ctrl",
    cmd: "Ctrl",
    alt: "Alt",
    option: "Alt",
    altgr: "AltGr",
    shift: "Shift",
    super: "Win",
    meta: "Win"
  };

  function keyFromCode(code: string): string | null {
    if (CODE_TO_KEY[code]) return CODE_TO_KEY[code];
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    if (/^Numpad[0-9]$/.test(code)) return `num${code.slice(6)}`;
    if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code;
    return null;
  }

  /**
   * The Electron accelerator for a keypress, or null if it isn't one yet — a modifier on its own,
   * or a key with no Electron name. Null means "keep listening", not "rejected".
   */
  function acceleratorFromEvent(event: KeyboardEvent): string | null {
    const key = keyFromCode(event.code);
    if (key === null) return null;

    const parts: string[] = [];
    // `CommandOrControl` rather than `Control`, matching the spelling the shipped defaults use.
    if (event.ctrlKey) parts.push("CommandOrControl");
    if (event.altKey) parts.push("Alt");
    if (event.shiftKey) parts.push("Shift");
    if (event.metaKey) parts.push("Super");
    parts.push(key);
    return parts.join("+");
  }

  /** "CommandOrControl+Shift+O" as "Ctrl + Shift + O". */
  function formatAccelerator(accelerator: string): string {
    return accelerator
      .split("+")
      .map((token) => MODIFIER_LABELS[token.toLowerCase()] ?? token)
      .join(" + ");
  }

  function recorderFor(name: HotkeyName): HTMLButtonElement {
    return document.querySelector(`[data-hotkey="${name}"]`) as HTMLButtonElement;
  }

  function renderHotkey(name: HotkeyName): void {
    const button = recorderFor(name);
    if (recording === name) {
      button.textContent = "Press a combination…";
      button.classList.add("recording");
      button.classList.remove("unbound");
      return;
    }
    button.classList.remove("recording");
    button.classList.toggle("unbound", hotkeys[name] === "");
    button.textContent = hotkeys[name] === "" ? "Not bound" : formatAccelerator(hotkeys[name]);
  }

  function setStatus(text: string, kind: "" | "ok" | "warn"): void {
    statusEl.textContent = text;
    statusEl.className = kind ? `status ${kind}` : "status";
  }

  function stopRecording(): void {
    const was = recording;
    recording = null;
    if (was) renderHotkey(was);
  }

  function startRecording(name: HotkeyName): void {
    stopRecording();
    recording = name;
    // Whatever the last save said is about the old bindings, and is now misleading.
    setStatus("", "");
    renderHotkey(name);
  }

  /*
   * One document-level listener rather than one per button: while recording, the keypress belongs to
   * the page, not to whichever control happens to hold focus. Capture phase and preventDefault stop
   * the recorder button — which still has focus from the click that armed it — from treating Space
   * or Enter as a second press of itself.
   */
  document.addEventListener(
    "keydown",
    (event) => {
      if (!recording) return;
      event.preventDefault();

      // Bare, so they can't be the start of a combination the user is still assembling.
      const bare = !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey;
      if (bare && event.code === "Escape") {
        stopRecording();
        return;
      }
      if (bare && (event.code === "Backspace" || event.code === "Delete")) {
        hotkeys[recording] = "";
        stopRecording();
        return;
      }

      const accelerator = acceleratorFromEvent(event);
      // A modifier on its own, or a key Electron has no name for: keep waiting rather than binding
      // something the user didn't finish typing.
      if (accelerator === null) return;
      if (bare) {
        setStatus("That needs a modifier — hold Ctrl, Alt or Shift.", "warn");
        return;
      }

      hotkeys[recording] = accelerator;
      stopRecording();
    },
    true
  );

  // Recording survives a click elsewhere on the page but not the window losing focus — at that point
  // the keys are going somewhere else entirely and the armed field is a lie.
  window.addEventListener("blur", () => stopRecording());

  for (const name of HOTKEY_NAMES) {
    recorderFor(name).addEventListener("click", () => startRecording(name));

    const clear = document.querySelector(`[data-clear="${name}"]`) as HTMLButtonElement;
    clear.addEventListener("click", () => {
      stopRecording();
      hotkeys[name] = "";
      renderHotkey(name);
    });

    const reset = document.querySelector(`[data-reset="${name}"]`) as HTMLButtonElement;
    reset.addEventListener("click", () => {
      if (!defaults) return;
      stopRecording();
      hotkeys[name] = defaults.hotkeys[name];
      renderHotkey(name);
    });
  }

  /**
   * A number input's value, clamped. `min`/`max` on the element only style an out-of-range value —
   * they don't stop it being read — and a panel 0px wide is not a recoverable mistake from inside
   * a window that would then be the only way to fix it.
   */
  function readNumber(input: HTMLInputElement, fallback: number, min: number, max: number): number {
    // An emptied box falls back rather than reading as zero. `Number("")` is 0, not NaN, so without
    // this clearing the hide delay would silently mean "hide instantly" — a plausible setting, and
    // therefore one that has to be typed rather than arrived at by deleting.
    if (input.value.trim() === "") return fallback;
    const value = Number(input.value);
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.round(value)));
  }

  function apply(config: SettingsConfig): void {
    loaded = config;
    for (const name of HOTKEY_NAMES) {
      hotkeys[name] = config.hotkeys[name];
      renderHotkey(name);
    }
    hideUnfocusedInput.checked = config.overlay.hideWhenGameUnfocused;
    hideDelayInput.value = String(config.overlay.hideDelayMs);
    panelWidthInput.value = String(config.overlay.panel.width);
    panelHeightInput.value = String(config.overlay.panel.maxHeightPercent);
    panelPositionSelect.value = config.overlay.panel.position;
    currencySelect.value = config.display.currency;
    listingStatusSelect.value = config.trade2.listingStatus;
    saleTypeSelect.value = config.trade2.saleType;
    useMapFiltersInput.checked = config.trade2.useMapFilters;
    // Edited as a percentage and stored as a ratio. `readNumber` rounds to whole numbers, so a ratio
    // typed directly would be unusable — 0.9 rounds to 1, i.e. silently "no widening at all".
    mapRatioInput.value = String(Math.round(config.trade2.mapMinRatio * 100));
  }

  async function load(): Promise<void> {
    const state = await window.poe2Settings.getConfig();
    defaults = state.defaults;
    apply(state);
  }

  saveButton.addEventListener("click", async () => {
    // Nothing has been filled in yet, so there is nothing to send. Only reachable if the initial
    // load failed, in which case saving would write the empty form over real settings.
    if (!loaded) return;

    stopRecording();
    saveButton.disabled = true;
    setStatus("Saving…", "");

    const result = await window.poe2Settings.save({
      hotkeys: { ...hotkeys },
      overlay: {
        hideWhenGameUnfocused: hideUnfocusedInput.checked,
        hideDelayMs: readNumber(hideDelayInput, loaded.overlay.hideDelayMs, 0, 10000),
        panel: {
          width: readNumber(panelWidthInput, loaded.overlay.panel.width, 240, 1200),
          maxHeightPercent: readNumber(panelHeightInput, loaded.overlay.panel.maxHeightPercent, 20, 100),
          position: panelPositionSelect.value as SettingsConfig["overlay"]["panel"]["position"]
        }
      },
      display: { currency: currencySelect.value as SettingsConfig["display"]["currency"] },
      trade2: {
        saleType: saleTypeSelect.value as SettingsConfig["trade2"]["saleType"],
        listingStatus: listingStatusSelect.value as SettingsConfig["trade2"]["listingStatus"],
        useMapFilters: useMapFiltersInput.checked,
        mapMinRatio:
          readNumber(mapRatioInput, Math.round(loaded.trade2.mapMinRatio * 100), 50, 100) / 100
      }
    });

    saveButton.disabled = false;

    // Nothing was written in this case, so the form still shows exactly what was rejected.
    if (result.invalid.length > 0) {
      const first = result.invalid[0];
      setStatus(`Not saved — ${formatAccelerator(first.accelerator)}: ${first.reason}`, "warn");
      return;
    }
    // Written and applied, but the OS is handing that combination to something else for now.
    if (result.refused.length > 0) {
      const combos = result.refused.map((entry) => formatAccelerator(entry.accelerator)).join(", ");
      setStatus(
        `Saved, but Windows or another app is already using ${combos} — it'll start working once ` +
          `whatever holds it is closed.`,
        "warn"
      );
      return;
    }
    setStatus("Saved.", "ok");
  });

  void load();
})();
