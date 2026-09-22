import { useRef, useState } from "react";
import { Pressable, Text, TextInput, View, StyleSheet } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Button } from "@/components/ui/Button";
import { Caret } from "@/components/ui/Caret";
import { Screen } from "@/components/ui/Screen";
import { ScreenHeader } from "@/components/ui/ScreenHeader";
import { isApiConfigured, startPhoneAuth, toE164, verifyPhoneAuth } from "@/services/api";
import { ApiError, isApiUnavailable } from "@/services/errors";
import { saveSession } from "@/services/session";
import { colors } from "@/theme/tokens";
import { typography } from "@/theme/typography";

const LENGTH = 6;

export default function VerifyCodeScreen() {
  const { phone, e164, challengeId: challengeParam } = useLocalSearchParams<{
    phone?: string;
    e164?: string;
    challengeId?: string;
  }>();
  const [code, setCode] = useState("");
  const [challengeId, setChallengeId] = useState(typeof challengeParam === "string" ? challengeParam : "");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const inputRef = useRef<TextInput>(null);

  function goOffline() {
    router.push("/keygen");
  }

  async function onVerify() {
    if (busy) return;
    if (!challengeId) {
      goOffline();
      return;
    }
    if (code.length < LENGTH) {
      setNote("enter the code");
      return;
    }

    setBusy(true);
    setNote("");
    try {
      const session = await verifyPhoneAuth(challengeId, code);
      try {
        await saveSession(session.sessionToken, session.userId);
      } catch {
        // Keystore is unavailable on web. The verified session still continues.
      }
      router.push("/keygen");
    } catch (err) {
      if (isApiUnavailable(err)) {
        goOffline();
        return;
      }
      setNote(err instanceof ApiError ? err.message : "could not verify");
    } finally {
      setBusy(false);
    }
  }

  async function onResend() {
    setCode("");
    setNote("");
    const target = (typeof e164 === "string" && e164) || (typeof phone === "string" ? toE164(phone) : "");
    if (!target || !isApiConfigured()) return;
    try {
      const next = await startPhoneAuth(target);
      setChallengeId(next.challengeId);
    } catch (err) {
      if (!isApiUnavailable(err)) {
        setNote(err instanceof ApiError ? err.message : "could not resend");
      }
    }
  }

  return (
    <Screen>
      <ScreenHeader onBack={() => router.back()} />
      <Pressable style={styles.body} onPress={() => inputRef.current?.focus()}>
        <Text style={[typography.display, { fontSize: 24 }]}>Enter code</Text>
        <Text style={[typography.body, styles.help]}>
          Sent to <Text style={[typography.mono, { color: colors.chalk }]}>{phone ?? "[ PHONE NUMBER ]"}</Text>
        </Text>
        <View style={styles.boxes}>
          {Array.from({ length: LENGTH }).map((_, i) => {
            const active = i === code.length;
            const char = code[i];
            return (
              <View key={i} style={[styles.box, active && styles.boxActive]}>
                {char ? (
                  <Text style={[typography.mono, { fontSize: 22 }]}>{char}</Text>
                ) : active ? (
                  <Caret height={18} />
                ) : null}
              </View>
            );
          })}
        </View>
        <TextInput
          ref={inputRef}
          value={code}
          onChangeText={(t) => setCode(t.replace(/\D/g, "").slice(0, LENGTH))}
          keyboardType="number-pad"
          autoFocus
          style={styles.hidden}
        />
        <Pressable onPress={() => void onResend()} style={{ marginTop: 20 }}>
          <Text style={[typography.mono, { fontSize: 13 }]}>Resend code</Text>
        </Pressable>
        {note ? <Text style={[typography.mono, styles.note]}>{note}</Text> : null}
      </Pressable>
      <View style={styles.footer}>
        <Button label="Verify" disabled={busy} onPress={() => void onVerify()} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: {
    flex: 1,
    paddingHorizontal: 22,
    paddingTop: 28,
  },
  help: {
    fontSize: 13.5,
    lineHeight: 20,
    color: colors.smoke,
    marginTop: 8,
  },
  boxes: {
    flexDirection: "row",
    gap: 8,
    marginTop: 28,
  },
  box: {
    width: 42,
    height: 52,
    backgroundColor: colors.ash,
    borderWidth: 1,
    borderColor: colors.rule,
    alignItems: "center",
    justifyContent: "center",
  },
  boxActive: {
    borderColor: colors.white,
  },
  hidden: {
    position: "absolute",
    opacity: 0,
    height: 1,
    width: 1,
  },
  note: {
    fontSize: 12,
    color: colors.smoke,
    marginTop: 16,
  },
  footer: {
    paddingHorizontal: 22,
    paddingBottom: 16,
  },
});
