import { useEffect, useRef, useState } from "react";
import {
  Keyboard,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
  StyleSheet,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import { Button } from "@/components/ui/Button";
import { Caret } from "@/components/ui/Caret";
import { isApiConfigured, startPhoneAuth, toE164, verifyPhoneAuth } from "@/services/api";
import { ApiError, isApiUnavailable } from "@/services/errors";
import { syncPushRegistration } from "@/services/push";
import { saveSession } from "@/services/session";
import { colors } from "@/theme/tokens";
import { typography } from "@/theme/typography";

const LENGTH = 6;

export default function VerifyCodeScreen() {
  const insets = useSafeAreaInsets();
  const { phone, e164, challengeId: challengeParam } = useLocalSearchParams<{
    phone?: string;
    e164?: string;
    challengeId?: string;
  }>();
  const [code, setCode] = useState("");
  const [challengeId, setChallengeId] = useState(typeof challengeParam === "string" ? challengeParam : "");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    const show = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow",
      (e) => setKeyboardHeight(e.endCoordinates.height),
    );
    const hide = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide",
      () => setKeyboardHeight(0),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  function goOffline() {
    router.replace("/keygen");
  }

  async function onVerify() {
    if (busy) return;
    Keyboard.dismiss();
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
      void syncPushRegistration();
      router.replace("/keygen");
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

  const footerOffset = keyboardHeight > 0 ? keyboardHeight : Math.max(insets.bottom, 12);

  return (
    <View style={styles.root}>
      <Pressable
        style={[styles.body, { paddingTop: insets.top + 16, paddingBottom: 88 }]}
        onPress={() => inputRef.current?.focus()}
      >
        <Pressable
          onPress={() => router.back()}
          hitSlop={12}
          style={styles.back}
          accessibilityLabel="Back"
        >
          <Text style={[typography.mono, { fontSize: 14, color: colors.chalk }]}>← back</Text>
        </Pressable>
        <Text style={[typography.display, { fontSize: 24 }]}>Enter code</Text>
        <Text style={[typography.body, styles.help]}>
          Sent to{" "}
          <Text style={[typography.mono, { color: colors.chalk }]}>
            {phone ?? "[ PHONE NUMBER ]"}
          </Text>
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

      <View style={[styles.footer, { bottom: footerOffset }]}>
        <Button label={busy ? "…" : "Verify"} disabled={busy} onPress={() => void onVerify()} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.black,
  },
  body: {
    flex: 1,
    paddingHorizontal: 22,
  },
  back: {
    marginBottom: 18,
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
    position: "absolute",
    left: 0,
    right: 0,
    paddingHorizontal: 22,
    paddingTop: 12,
    paddingBottom: 12,
    backgroundColor: colors.black,
    borderTopWidth: 1,
    borderTopColor: colors.rule,
  },
});
