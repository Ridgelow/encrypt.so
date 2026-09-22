import { useRef, useState } from "react";
import { Pressable, Text, TextInput, View, StyleSheet } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Button } from "@/components/ui/Button";
import { Caret } from "@/components/ui/Caret";
import { Screen } from "@/components/ui/Screen";
import { ScreenHeader } from "@/components/ui/ScreenHeader";
import { colors } from "@/theme/tokens";
import { typography } from "@/theme/typography";

const LENGTH = 6;

export default function VerifyCodeScreen() {
  const { phone } = useLocalSearchParams<{ phone?: string }>();
  const [code, setCode] = useState("");
  const inputRef = useRef<TextInput>(null);

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
        <Pressable onPress={() => setCode("")} style={{ marginTop: 20 }}>
          <Text style={[typography.mono, { fontSize: 13 }]}>Resend code</Text>
        </Pressable>
      </Pressable>
      <View style={styles.footer}>
        <Button label="Verify" onPress={() => router.push("/keygen")} />
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
  footer: {
    paddingHorizontal: 22,
    paddingBottom: 16,
  },
});
