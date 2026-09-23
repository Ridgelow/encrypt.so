import { useEffect, useRef, useState } from "react";
import { Text, View, StyleSheet } from "react-native";
import { router } from "expo-router";
import { DeviceKeyStoreUnavailableError } from "@/e2ee";
import { IconCheck } from "@/components/icons";
import { useDeviceKeys } from "@/hooks/useDeviceKeys";
import { syncPushRegistration } from "@/services/push";
import { Screen } from "@/components/ui/Screen";
import { colors } from "@/theme/tokens";
import { typography } from "@/theme/typography";

const STEPS = [
  "Generating identity key pair",
  "Generating signed prekey",
  "Generating 100 one-time prekeys",
  "Uploading public keys",
  "Establishing session",
];

export default function KeyGenScreen() {
  const [progress, setProgress] = useState(0);
  const [doneCount, setDoneCount] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const { registerDevice } = useDeviceKeys();
  const finished = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let tick: ReturnType<typeof setInterval> | null = null;

    tick = setInterval(() => {
      setProgress((p) => {
        // Cap visual progress at 90% until keys actually upload.
        const next = Math.min(p + 3, 90);
        setDoneCount(Math.min(STEPS.length - 1, Math.floor((next / 90) * (STEPS.length - 1))));
        return next;
      });
    }, 80);

    void (async () => {
      try {
        const result = await registerDevice();
        if (cancelled || finished.current) return;
        // `uploaded` is false when this install already published to the API earlier.
        if (!result.uploaded && !result.serverDeviceId) {
          setStatus("Keys stayed on this device — check your connection, then try again.");
          if (tick) clearInterval(tick);
          return;
        }
        finished.current = true;
        if (tick) clearInterval(tick);
        setProgress(100);
        setDoneCount(STEPS.length);
        void syncPushRegistration();
        setTimeout(() => {
          if (!cancelled) router.replace("/profile");
        }, 400);
      } catch (error: unknown) {
        if (cancelled || finished.current) return;
        if (tick) clearInterval(tick);
        if (error instanceof DeviceKeyStoreUnavailableError) {
          setStatus("Secure storage is unavailable on this device.");
          return;
        }
        console.warn("[encrypt] device key provisioning did not complete", error);
        setStatus(
          error instanceof Error
            ? error.message
            : "Could not upload public keys. Pull to retry from Messages later.",
        );
      }
    })();

    return () => {
      cancelled = true;
      if (tick) clearInterval(tick);
    };
  }, [registerDevice]);

  const activeIndex = Math.min(STEPS.length - 1, doneCount);

  return (
    <Screen>
      <View style={styles.body}>
        <Text style={[typography.label, { fontSize: 10 }]}>Signal Protocol</Text>
        <Text style={[typography.display, styles.title]}>generating keys</Text>
        <View style={styles.track}>
          <View style={[styles.fill, { width: `${progress}%` }]} />
          <View style={[styles.cursor, { left: `${Math.max(0, progress - 2)}%` }]} />
        </View>
        <View style={styles.pctRow}>
          <Text style={[typography.mono, { fontSize: 11, color: colors.smoke }]}>{progress}%</Text>
        </View>
        <View style={{ marginTop: 22 }}>
          {STEPS.map((step, i) => {
            const done = i < doneCount || (progress >= 100 && i <= STEPS.length - 1);
            const active = i === activeIndex && progress < 100;
            const pending = i > activeIndex;
            return (
              <View key={step} style={styles.step}>
                <View
                  style={[
                    styles.stepBox,
                    done && !active && styles.stepDone,
                    active && styles.stepActive,
                    pending && styles.stepPending,
                  ]}
                >
                  {done && !active ? <IconCheck size={12} /> : null}
                </View>
                <Text
                  style={[
                    typography.mono,
                    styles.stepText,
                    pending && { color: colors.steel },
                    active && { color: colors.white },
                  ]}
                >
                  {step}
                </Text>
              </View>
            );
          })}
        </View>
        {status ? (
          <Text
            style={[typography.body, styles.note, { color: colors.smoke }]}
            onPress={() => {
              finished.current = false;
              setStatus(null);
              setProgress(0);
              setDoneCount(0);
              router.replace("/keygen");
            }}
          >
            {status} Tap to retry.
          </Text>
        ) : (
          <Text style={[typography.body, styles.note]}>
            Your private keys are generated on this device and never leave it.
          </Text>
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 26,
  },
  title: {
    fontSize: 26,
    marginTop: 8,
    marginBottom: 26,
  },
  track: {
    height: 10,
    backgroundColor: colors.iron,
    borderWidth: 1,
    borderColor: colors.rule,
    overflow: "hidden",
    marginBottom: 4,
    position: "relative",
  },
  fill: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    backgroundColor: colors.chalk,
  },
  cursor: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 3,
    backgroundColor: colors.white,
  },
  pctRow: {
    alignItems: "flex-end",
  },
  step: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 9,
  },
  stepBox: {
    width: 18,
    height: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  stepDone: {
    backgroundColor: colors.white,
  },
  stepActive: {
    borderWidth: 1,
    borderColor: colors.white,
  },
  stepPending: {
    borderWidth: 1,
    borderColor: colors.rule,
  },
  stepText: {
    fontSize: 12,
    color: colors.smoke,
    flex: 1,
  },
  note: {
    fontSize: 12,
    lineHeight: 18,
    color: colors.ghost,
    marginTop: 24,
  },
});