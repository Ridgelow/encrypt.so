import { useEffect } from "react";
import { Platform } from "react-native";

function loadNativePush() {
  return import("./push-native");
}

/**
 * Asks for notification permission, reads the Expo push token, and registers it
 * for the signed-in user. No-ops on web. Failures stay on device.
 */
export async function syncPushRegistration(): Promise<void> {
  if (Platform.OS !== "ios" && Platform.OS !== "android") return;
  const native = await loadNativePush();
  await native.syncPushRegistration();
}

/** Register after a session exists, and open the chat list from a metadata push. */
export function usePushLifecycle(): void {
  useEffect(() => {
    if (Platform.OS !== "ios" && Platform.OS !== "android") return;
    let remove: (() => void) | undefined;
    let cancelled = false;
    void loadNativePush().then((native) => {
      if (cancelled) return;
      void native.syncPushRegistration();
      remove = native.listenForPushOpens();
    });
    return () => {
      cancelled = true;
      remove?.();
    };
  }, []);
}
