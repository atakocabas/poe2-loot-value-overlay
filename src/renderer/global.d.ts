import type { PricedItem, Session } from "../shared/types";
import type { RepriceResult, SetManualPriceResult } from "../preload/index";

declare global {
  type PricedItem = import("../shared/types").PricedItem;
  type Session = import("../shared/types").Session;
  type ZoneStatus = import("../shared/types").ZoneStatus;
  type OverlayStatus = import("../shared/types").OverlayStatus;
  type SetupConfig = import("../shared/types").SetupConfig;
  type SetupState = import("../shared/types").SetupState;

  interface Window {
    poe2Overlay: {
      onPricedItem: (callback: (item: PricedItem) => void) => void;
      onSessionUpdate: (callback: (session: Session) => void) => void;
      onZoneStatus: (callback: (status: ZoneStatus) => void) => void;
      onOverlayStatus: (callback: (status: OverlayStatus) => void) => void;
      getStatus: () => Promise<OverlayStatus>;
      getHistory: () => Promise<Session[]>;
      getAllItems: () => Promise<PricedItem[]>;
      clearHistory: () => Promise<void>;
      repriceItem: (itemId: string, ignoredMods: string[]) => Promise<RepriceResult>;
      setManualPrice: (itemId: string, value: number | null) => Promise<SetManualPriceResult>;
    };
    /** Exposed by the same preload, but only ever called from setup.html. */
    poe2Setup: {
      getConfig: () => Promise<SetupState>;
      browseClientTxt: () => Promise<string | null>;
      save: (config: SetupConfig) => Promise<void>;
    };
  }
}

export {};
