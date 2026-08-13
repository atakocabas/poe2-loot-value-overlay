import type { PricedItem, Session } from "../shared/types";
import type { EditorRowsResult, RepriceResult, SetManualPriceResult } from "../preload/index";

declare global {
  type PricedItem = import("../shared/types").PricedItem;
  type Session = import("../shared/types").Session;
  type ZoneStatus = import("../shared/types").ZoneStatus;
  type OverlayStatus = import("../shared/types").OverlayStatus;
  type SetupConfig = import("../shared/types").SetupConfig;
  type SetupState = import("../shared/types").SetupState;
  type SettingsConfig = import("../shared/types").SettingsConfig;
  type SettingsState = import("../shared/types").SettingsState;
  type SettingsSaveResult = import("../shared/types").SettingsSaveResult;
  type ParsedItem = import("../shared/types").ParsedItem;
  type ParsedMod = import("../shared/types").ParsedMod;
  type PendingCapture = import("../shared/types").PendingCapture;
  type ModFilter = import("../shared/types").ModFilter;
  type PseudoStat = import("../shared/types").PseudoStat;
  type MapRow = import("../shared/types").MapRow;
  type EditorRowsResult = import("../preload/index").EditorRowsResult;

  interface Window {
    poe2Overlay: {
      onPricedItem: (callback: (item: PricedItem) => void) => void;
      onSessionUpdate: (callback: (session: Session) => void) => void;
      onZoneStatus: (callback: (status: ZoneStatus) => void) => void;
      onOverlayStatus: (callback: (status: OverlayStatus) => void) => void;
      onPricingStatus: (callback: (pending: PendingCapture[]) => void) => void;
      getStatus: () => Promise<OverlayStatus>;
      getHistory: () => Promise<Session[]>;
      getAllItems: () => Promise<PricedItem[]>;
      clearHistory: () => Promise<void>;
      getEditorRows: (itemId: string) => Promise<EditorRowsResult>;
      repriceItem: (
        itemId: string,
        ignoredMods: string[],
        modFilters: ModFilter[],
        pseudoFilters: ModFilter[],
        mapFilters: ModFilter[]
      ) => Promise<RepriceResult>;
      setManualPrice: (itemId: string, value: number | null) => Promise<SetManualPriceResult>;
    };
    /** Exposed by the same preload, but only ever called from setup.html. */
    poe2Setup: {
      getConfig: () => Promise<SetupState>;
      browseClientTxt: () => Promise<string | null>;
      save: (config: SetupConfig) => Promise<void>;
    };
    /** Likewise, and only ever called from settings.html. Saving applies live rather than closing. */
    poe2Settings: {
      getConfig: () => Promise<SettingsState>;
      save: (config: SettingsConfig) => Promise<SettingsSaveResult>;
    };
  }
}

export {};
