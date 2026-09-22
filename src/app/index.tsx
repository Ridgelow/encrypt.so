import { useEffect } from "react";
import { Image, Text, View, StyleSheet } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Caret } from "@/components/ui/Caret";
import { colors } from "@/theme/tokens";
import { typography } from "@/theme/typography";

export default function SplashScreen() {
  const insets = useSafeAreaInsets();

  useEffect(() => {
    const t = setTimeout(() => router.replace("/welcome"), 1800);
    return () => clearTimeout(t);
  }, []);

  return (
    <View style={[styles.root, { paddingBottom: insets.bottom + 28 }]}>
      <View style={styles.center}>
        <Text style={[typography.mono, { fontSize: 12, color: colors.steel }]}>$ boot --secure</Text>
        <Text style={[typography.mono, { fontSize: 12, color: colors.smoke, marginTop: 10 }]}>
          establishing identity ...... ok
        </Text>
        <View style={styles.wordmarkRow}>
          <Text style={[typography.wordmark, { fontSize: 52 }]}>encrypt</Text>
          <Caret height={28} />
        </View>
      </View>
      <View style={styles.footer}>
        <Image
          source={require("../../assets/images/hr-mark-white.png")}
          style={styles.mark}
          accessibilityLabel="HR mark"
        />
        <Text style={[typography.mono, { fontSize: 11, color: colors.steel }]}>secured by HR</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.black,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  wordmarkRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 10,
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  mark: {
    width: 22,
    height: 22,
    opacity: 0.6,
  },
});
