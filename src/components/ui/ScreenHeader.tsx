import { type ReactNode } from "react";
import { Pressable, Text, View, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { IconBack } from "@/components/icons";
import { colors } from "@/theme/tokens";
import { typography } from "@/theme/typography";

type Props = {
  title?: string;
  subtitle?: string;
  onBack?: () => void;
  right?: ReactNode;
  hideBorder?: boolean;
};

export function ScreenHeader({ title, subtitle, onBack, right, hideBorder }: Props) {
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.wrap, { paddingTop: insets.top }, !hideBorder && styles.border]}>
      <View style={styles.row}>
        <View style={styles.side}>
          {onBack ? (
            <Pressable
              onPress={onBack}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Back"
              style={styles.iconBtn}
            >
              <IconBack />
            </Pressable>
          ) : null}
        </View>
        <View style={styles.center}>
          {title ? <Text style={[typography.display, styles.title]}>{title}</Text> : null}
          {subtitle ? <Text style={[typography.label, styles.sub]}>{subtitle}</Text> : null}
        </View>
        <View style={[styles.side, styles.sideRight]}>{right}</View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: colors.black,
  },
  border: {
    borderBottomWidth: 1,
    borderBottomColor: colors.rule,
  },
  row: {
    height: 56,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
  },
  side: {
    width: 36,
    height: 36,
    justifyContent: "center",
  },
  sideRight: {
    alignItems: "flex-end",
  },
  center: {
    flex: 1,
    alignItems: "center",
  },
  title: {
    fontSize: 18,
  },
  sub: {
    fontSize: 9,
    marginTop: 3,
  },
  iconBtn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
});
