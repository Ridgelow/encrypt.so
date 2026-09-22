import { useCallback, useEffect, useRef, useState } from "react";
import { DeviceKeyError, provisionDeviceKeys, type ProvisionResult } from "@/e2ee";

export type DeviceKeyPhase = "idle" | "running" | "ready" | "error";

function safeMessage(error: unknown): string {
  if (error instanceof DeviceKeyError) return error.message;
  return "Device key provisioning failed";
}

/** Call after phone verify, once a session may already be in Secure Store. */
export function useDeviceKeys() {
  const mounted = useRef(true);
  const [phase, setPhase] = useState<DeviceKeyPhase>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const registerDevice = useCallback(async (options?: { republish?: boolean }) => {
    if (mounted.current) {
      setPhase("running");
      setErrorMessage(null);
    }
    try {
      const result: ProvisionResult = await provisionDeviceKeys(options);
      if (mounted.current) setPhase("ready");
      return result;
    } catch (error) {
      if (mounted.current) {
        setPhase("error");
        setErrorMessage(safeMessage(error));
      }
      throw error;
    }
  }, []);

  return { phase, errorMessage, registerDevice };
}
