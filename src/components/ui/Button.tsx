import {
  Pressable,
  Text,
  View,
  StyleSheet,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { colors, fonts } from "@/theme/tokens";

type Variant = "primary" | "ghost" | "outline";

type Props = PressableProps & {
  label: string;
  variant?: Variant;
  style?: StyleProp<ViewStyle>;
};

export function Button({ label, variant = "primary", style, disabled, ...rest }: Props) {
  const isPrimary = variant === "primary";
  const isOutline = variant === "outline";

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      style={({ pressed }) => [
        { width: "100%" },
        (pressed || disabled) && { opacity: disabled ? 0.4 : 0.85 },
        style,
      ]}
      {...rest}
    >
      {/* Inner View owns the fill — NativeWind often drops Pressable backgroundColor on iOS */}
      <View
        style={[
          styles.face,
          isPrimary && styles.facePrimary,
          isOutline && styles.faceOutline,
          variant === "ghost" && styles.faceGhost,
        ]}
      >
        <Text
          style={[
            styles.label,
            isPrimary ? styles.labelOnPrimary : styles.labelMuted,
          ]}
        >
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

export function CheckBox({ checked }: { checked: boolean }) {
  return (
    <View style={[styles.check, checked && styles.checkOn]}>
      {checked ? (
        <Text style={{ color: colors.black, fontSize: 12, fontFamily: fonts.mono }}>✓</Text>
      ) : null}
    </View>
  );
}

export function InvertedCheck({ size = 18 }: { size?: number }) {
  return (
    <View style={[styles.invertedCheck, { width: size, height: size }]}>
      <View style={styles.checkMark} />
    </View>
  );
}

const styles = StyleSheet.create({
  face: {
    minHeight: 48,
    height: 48,
    width: "100%",
    alignItems: "center",
    justifyContent: "center",
  },
  facePrimary: {
    backgroundColor: "#ffffff",
  },
  faceOutline: {
    backgroundColor: "#000000",
    borderWidth: 1,
    borderColor: "#2e2e34",
  },
  faceGhost: {
    backgroundColor: "transparent",
  },
  label: {
    fontSize: 13,
    letterSpacing: 1.6,
    textTransform: "uppercase",
    fontWeight: "600",
    fontFamily: fonts.sansMedium,
  },
  labelOnPrimary: {
    color: "#000000",
  },
  labelMuted: {
    color: "#9a9aa2",
  },
  check: {
    width: 22,
    height: 22,
    borderWidth: 1,
    borderColor: colors.rule,
    alignItems: "center",
    justifyContent: "center",
  },
  checkOn: {
    backgroundColor: "#ffffff",
    borderColor: "#ffffff",
  },
  invertedCheck: {
    backgroundColor: "#ffffff",
    alignItems: "center",
    justifyContent: "center",
  },
  checkMark: {
    width: 8,
    height: 4,
    borderLeftWidth: 2,
    borderBottomWidth: 2,
    borderColor: "#000000",
    transform: [{ rotate: "-45deg" }, { translateY: -1 }],
  },
});
