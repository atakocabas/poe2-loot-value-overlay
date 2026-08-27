/**
 * A sleep the caller can cut short.
 *
 * The waits this serves are deliberately long. `GggRateLimiter`'s `restrictedSec` on a tripped
 * bucket is 30 minutes for the 5-minute rule and an hour for the 6-hour one, and `Trade2Client`
 * spaces every search by `minSearchIntervalMs` (15s by default, up to six times as the drop ladder
 * walks its rungs) — which is where most of a rare's wall clock goes. Until these took a signal
 * there was no way to stop serving one out. That is most of what "the app is stuck querying"
 * actually was: not a hung socket but a wait being served correctly, with no way to abandon the
 * item and move on.
 *
 * **Rejects with the signal's reason rather than resolving early**, so an abandoned wait can never
 * be mistaken for a wait that finished and fall through into the request it was throttling. A copy
 * of this that resolved instead is exactly how a pressed Stop came to report success while the
 * lookup carried on and priced the item anyway — which is why there is one of these and not two.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    // Named rather than inline so the resolve path above can remove it: these listeners outlive a
    // completed sleep otherwise, and one accumulates per request on a long-lived signal.
    function onAbort(): void {
      clearTimeout(timer);
      reject(signal!.reason);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
