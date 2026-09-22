import { Text, View, StyleSheet } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { IconCheck } from "@/components/icons";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Screen } from "@/components/ui/Screen";
import { ScreenHeader } from "@/components/ui/ScreenHeader";
import { safetyDigits } from "@/data/mock";
import { colors } from "@/theme/tokens";
import { typography } from "@/theme/typography";

export default function SafetyNumberScreen() {
  const { name } = useLocalSearchParams<{ name?: string }>();
  const display = name ?? "Sam";

  return (
    <Screen>
      <ScreenHeader title="Safety Number" onBack={() => router.back()} />
      <View style={styles.body}>
        <View style={styles.person}>
          <Avatar initials="SR" size={40} />
          <View>
            <Text style={[typography.body, { fontSize: 15, color: colors.white }]}>{display}</Text>
            <Text style={[typography.mono, { fontSize: 11, color: colors.ghost }]}>+1 (•••) •••-0192</Text>
          </View>
        </View>
        <Text style={[typography.body, styles.help]}>
          Compare this number with {display} through another channel — in person, or a call. If it matches on
          both devices, your connection is verified.
        </Text>
        <View style={styles.card}>
          <View style={styles.qrWrap}>
            <View style={styles.qr}>
              <Text style={[typography.label, { fontSize: 9 }]}>[ QR CODE ]</Text>
            </View>
          </View>
          <View style={styles.grid}>
            {safetyDigits.map((d) => (
              <Text key={d} style={[typography.mono, styles.digit]}>
                {d}
              </Text>
            ))}
          </View>
        </View>
        <View style={styles.verified}>
          <IconCheck size={14} />
          <Text style={[typography.label, { fontSize: 10, color: colors.black }]}>Verified</Text>
        </View>
      </View>
      <View style={styles.footer}>
        <Button label="Mark as Not Verified" variant="outline" onPress={() => router.back()} />
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
  footer: {
    paddingHorizontal: 22,
    paddingBottom: 16,
  },
});
