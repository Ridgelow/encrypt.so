import { useState } from "react";
import { Text, TextInput, View, StyleSheet } from "react-native";
import { router } from "expo-router";
import { Button } from "@/components/ui/Button";
import { Caret } from "@/components/ui/Caret";
import { Screen } from "@/components/ui/Screen";
import { ScreenHeader } from "@/components/ui/ScreenHeader";
import { isApiConfigured, startPhoneAuth, toE164 } from "@/services/api";
import { ApiError, isApiUnavailable } from "@/services/errors";
import { colors } from "@/theme/tokens";
import { typography } from "@/theme/typography";

export default function PhoneEntryScreen() {
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  async function onContinue() {
    if (busy) return;
    const shown = phone.trim() || "(555) 010-0192";
    const e164 = toE164(shown);
    if (!isApiConfigured() || !e164) {
      router.push({ pathname: "/verify", params: { phone: shown } });
      return;
    }

    setBusy(true);
    setNote("");
    try {
      const { challengeId } = await startPhoneAuth(e164);
      router.push({ pathname: "/verify", params: { phone: shown, e164, challengeId } });
    } catch (err) {
      if (isApiUnavailable(err)) {
        router.push({ pathname: "/verify", params: { phone: shown } });
        return;
      }
      setNote(err instanceof ApiError ? err.message : "could not start verification");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <ScreenHeader />
      <View style={styles.body}>
        <Text style={[typography.display, { fontSize: 24 }]}>Your number</Text>
        <Text style={[typography.body, styles.help]}>
          We'll text you a code to verify it's you. Your number is never shown to other users.
        </Text>
        <View style={styles.row}>
          <View style={styles.cc}>
            <Text style={[typography.mono, { fontSize: 15 }]}>+1</Text>
          </View>
          <View style={styles.phone}>
            <TextInput
              value={phone}
              onChangeText={setPhone}
              keyboardType="phone-pad"
              placeholder="Phone number"
              placeholderTextColor={colors.steel}
              style={[typography.mono, styles.input]}
              autoFocus
            />
            {!phone ? <Caret /> : null}
          </View>
        </View>
        {note ? <Text style={[typography.mono, styles.note]}>{note}</Text> : null}
      </View>
      <View style={styles.footer}>
        <Button label="Continue" disabled={busy} onPress={() => void onContinue()} />
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
  row: {
    flexDirection: "row",
    gap: 10,
    marginTop: 24,
  },
  cc: {
    width: 64,
    height: 48,
    backgroundColor: colors.ash,
    borderWidth: 1,
    borderColor: colors.rule,
    alignItems: "center",
    justifyContent: "center",
  },
  phone: {
    flex: 1,
    height: 48,
    backgroundColor: colors.ash,
    borderWidth: 1,
    borderColor: colors.white,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
  },
  input: {
    flex: 1,
    fontSize: 15,
    color: colors.chalk,
    padding: 0,
  },
  note: {
    fontSize: 12,
    color: colors.smoke,
    marginTop: 14,
  },
  footer: {
    paddingHorizontal: 22,
    paddingBottom: 16,
  },
});
