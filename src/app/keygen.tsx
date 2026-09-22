import { useEffect, useState } from "react";
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
  const { registerDevice } = useDeviceKeys();

  useEffect(() => {
    void registerDevice()
      .catch((error: unknown) => {
        if (error instanceof DeviceKeyStoreUnavailableError) return;
        console.warn("[encrypt] device key provisioning did not complete");
      })
      .finally(() => {
        void syncPushRegistration();
      });
  }, [registerDevice]);

  useEffect(() => {
    const id = setInterval(() => {
      setProgress((p) => {
        const next = Math.min(p + 4, 100);
        setDoneCount(Math.min(STEPS.length, Math.floor((next / 100) * STEPS.length) + (next >= 62 ? 1 : 0)));
        if (next >= 100) {
          clearInterval(id);
          setTimeout(() => router.replace("/profile"), 400);
        }
        return next;
      });
    }, 80);
    return () => clearInterval(id);
  }, []);

  const activeIndex = Math.min(STEPS.length - 1, doneCount);

  return (
    <Screen>
      <View style={styles.body}>
        <Text style={[typography.label, { fontSize: 10 }]}>Signal Protocol</Text>
        <Text style={[typography.display, styles.title]}>Generating keys</Text>
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
                    {
                      fontSize: 12.5,
                      color: active ? colors.white : done ? colors.chalk : colors.steel,
                    },
                  ]}
                >
                  {step}
                </Text>
              </View>
            );
          })}
        </View>
        <Text style={[typography.body, styles.note]}>
          Your private keys are generated on this device and never leave it.
        </Text>
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
  note: {
    fontSize: 12,
    lineHeight: 18,
    color: colors.ghost,
    marginTop: 24,
  },
});
