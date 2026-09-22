import { Text, View, StyleSheet, ScrollView, Pressable } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { IconCheck, IconLock } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { Screen } from "@/components/ui/Screen";
import { colors } from "@/theme/tokens";
import { typography } from "@/theme/typography";

const features = [
  {
    title: "End-to-end encrypted",
    body: "Every message uses the Signal Protocol. Nobody but you and the recipient can read them — not even us.",
  },
  {
    title: "Forward secrecy",
    body: "Each message gets its own key. A compromised device can't unlock your past conversations.",
  },
  {
    title: "Disappearing messages",
    body: "Set a timer per chat. Messages remove themselves on both ends when it runs out.",
  },
];

export default function WelcomeScreen() {
  const insets = useSafeAreaInsets();

  return (
    <Screen style={{ paddingTop: insets.top + 28 }}>
      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <IconLock size={34} color={colors.smoke} strokeWidth={1.8} />
        <Text style={[typography.display, styles.title]}>Private by design</Text>
        <Text style={[typography.body, styles.subtitle]}>
          Encrypted messaging that never leaves your devices in the clear.
        </Text>
        {features.map((f) => (
          <View key={f.title} style={styles.feature}>
            <View style={styles.check}>
              <IconCheck size={14} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[typography.body, { fontSize: 15, color: colors.white }]}>{f.title}</Text>
              <Text style={[typography.body, { fontSize: 13, lineHeight: 19, color: colors.smoke, marginTop: 4 }]}>
                {f.body}
              </Text>
            </View>
          </View>
        ))}
      </ScrollView>
      <View style={styles.footer}>
        <Button label="Get Started" onPress={() => router.push("/phone")} />
        <Pressable onPress={() => router.push("/phone")} style={{ alignItems: "center", paddingVertical: 8 }}>
          <Text style={[typography.mono, { fontSize: 13 }]}>I already have an account</Text>
        </Pressable>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: {
    paddingHorizontal: 22,
    paddingBottom: 12,
  },
  title: {
    fontSize: 30,
    lineHeight: 34,
    marginTop: 18,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    lineHeight: 21,
    color: colors.smoke,
    marginBottom: 8,
  },
  feature: {
    flexDirection: "row",
    gap: 12,
    paddingVertical: 16,
    borderTopWidth: 1,
    borderTopColor: colors.iron,
  },
  check: {
    width: 22,
    height: 22,
    backgroundColor: colors.white,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
  },
  footer: {
    paddingHorizontal: 22,
    paddingBottom: 16,
    gap: 8,
  },
});
