import { useEffect, useState } from "react";
import { Text, View, StyleSheet } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { IconCheck } from "@/components/icons";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Screen } from "@/components/ui/Screen";
import { ScreenHeader } from "@/components/ui/ScreenHeader";
import {
  ensureSessionWithUser,
  isPeerUserId,
  readPeerVerification,
  safetyNumberForPeer,
  setPeerVerified,
  verificationMatches,
  type SafetyFingerprint,
} from "@/e2ee";
import { colors } from "@/theme/tokens";
import { typography } from "@/theme/typography";

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function initialsOf(name: string, explicit?: string): string {
  if (explicit && explicit.trim()) return explicit.trim().slice(0, 3).toUpperCase();
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
  }
  return name.replace(/\s/g, "").slice(0, 2).toUpperCase() || "??";
}

function FingerprintMark({ seed }: { seed: string }) {
  const cells = Array.from({ length: 64 }, (_, index) => {
    const char = seed[index % Math.max(seed.length, 1)] ?? "0";
    const value = Number.parseInt(char, 16);
    return Number.isNaN(value) ? char.charCodeAt(0) % 2 === 1 : value >= 8;
  });
  return (
    <View style={styles.modules}>
      {cells.map((on, index) => (
        <View key={index} style={[styles.module, on ? styles.moduleOn : styles.moduleOff]} />
      ))}
    </View>
  );
}

export default function SafetyNumberScreen() {
  const params = useLocalSearchParams<{ id: string; name?: string; userId?: string; initials?: string }>();
  const name = firstParam(params.name);
  const userId = firstParam(params.userId);
  const routeId = firstParam(params.id);
  const display = name ?? "Contact";
  const peerUserId = isPeerUserId(userId) ? userId : isPeerUserId(routeId) ? routeId : null;
  const initials = initialsOf(display, firstParam(params.initials));

  const [fingerprint, setFingerprint] = useState<SafetyFingerprint | null>(null);
  const [verified, setVerified] = useState(false);
  const [changed, setChanged] = useState(false);
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">(peerUserId ? "loading" : "unavailable");

  useEffect(() => {
    if (!peerUserId) {
      setFingerprint(null);
      setVerified(false);
      setChanged(false);
      setStatus("unavailable");
      return;
    }
    let cancelled = false;
    setStatus("loading");
    void (async () => {
      try {
        await ensureSessionWithUser(peerUserId);
        const next = await safetyNumberForPeer(peerUserId);
        const saved = await readPeerVerification(peerUserId);
        if (cancelled) return;
        setFingerprint(next);
        setVerified(verificationMatches(saved, next));
        setChanged(saved != null && !verificationMatches(saved, next));
        setStatus("ready");
      } catch {
        if (cancelled) return;
        setFingerprint(null);
        setVerified(false);
        setChanged(false);
        setStatus("unavailable");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [peerUserId]);

  async function toggleVerified() {
    if (!peerUserId || !fingerprint) return;
    const next = !verified;
    try {
      await setPeerVerified(peerUserId, fingerprint.digits, next);
      setVerified(next);
      setChanged(false);
    } catch {
      setStatus("unavailable");
    }
  }

  const digits = fingerprint?.groups ?? [];

  return (
    <Screen>
      <ScreenHeader title="Safety Number" onBack={() => router.back()} />
      <View style={styles.body}>
        <View style={styles.person}>
          <Avatar initials={initials} size={40} />
          <View>
            <Text style={[typography.body, { fontSize: 15, color: colors.white }]}>{display}</Text>
            <Text style={[typography.mono, { fontSize: 11, color: colors.ghost }]}>
              {peerUserId ? peerUserId.slice(0, 8) : "No encrypted session"}
            </Text>
          </View>
        </View>
        <Text style={[typography.body, styles.help]}>
          Compare this number with {display} through another channel — in person, or a call. If it matches on
          both devices, your connection is verified.
        </Text>
        <View style={styles.card}>
          <View style={styles.qrWrap}>
            <View style={styles.qr}>
              {fingerprint ? <FingerprintMark seed={fingerprint.hex || fingerprint.digits} /> : (
                <Text style={[typography.label, { fontSize: 9, textAlign: "center", paddingHorizontal: 8 }]}>
                  {status === "loading" ? "LOADING" : "NO NUMBER"}
                </Text>
              )}
            </View>
          </View>
          {digits.length > 0 ? (
            <View style={styles.grid}>
              {digits.map((group, index) => (
                <Text key={`${group}-${index}`} style={[typography.mono, styles.digit]}>
                  {group}
                </Text>
              ))}
            </View>
          ) : (
            <Text style={[typography.mono, styles.empty]}>
              {status === "loading"
                ? "Reading identity keys…"
                : "Start an encrypted chat on this device to compare a safety number."}
            </Text>
          )}
        </View>
        {verified ? (
          <View style={styles.verified}>
            <IconCheck size={14} />
            <Text style={[typography.label, { fontSize: 10, color: colors.black }]}>Verified</Text>
          </View>
        ) : null}
        {changed ? (
          <Text style={[typography.mono, styles.changed]}>
            Safety number changed. Compare it again before trusting this chat.
          </Text>
        ) : null}
      </View>
      <View style={styles.footer}>
        <Button
          label={verified ? "Mark as Not Verified" : "Mark as Verified"}
          variant={verified ? "outline" : "primary"}
          disabled={status !== "ready" || !fingerprint}
          onPress={() => {
            void toggleVerified();
          }}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: {
    flex: 1,
    paddingHorizontal: 22,
    paddingTop: 24,
  },
  person: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  help: {
    fontSize: 13,
    lineHeight: 20,
    color: colors.smoke,
    marginTop: 18,
  },
  card: {
    marginTop: 20,
    backgroundColor: colors.ash,
    borderWidth: 1,
    borderColor: colors.rule,
    padding: 18,
  },
  qrWrap: {
    alignItems: "center",
    marginBottom: 14,
  },
  qr: {
    width: 120,
    height: 120,
    backgroundColor: colors.graphite,
    borderWidth: 1,
    borderColor: colors.rule,
    alignItems: "center",
    justifyContent: "center",
  },
  modules: {
    width: 96,
    height: 96,
    flexDirection: "row",
    flexWrap: "wrap",
  },
  module: {
    width: 12,
    height: 12,
  },
  moduleOn: {
    backgroundColor: colors.white,
  },
  moduleOff: {
    backgroundColor: colors.graphite,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    rowGap: 10,
  },
  digit: {
    width: "33%",
    textAlign: "center",
    fontSize: 16,
    letterSpacing: 0.6,
  },
  empty: {
    fontSize: 12,
    lineHeight: 18,
    color: colors.smoke,
    textAlign: "center",
  },
  verified: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 18,
    backgroundColor: colors.white,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  changed: {
    marginTop: 14,
    fontSize: 11,
    lineHeight: 16,
    color: colors.smoke,
  },
  footer: {
    paddingHorizontal: 22,
    paddingBottom: 16,
  },
});
