import {
  Pressable,
  Text,
  View,
  StyleSheet,
  type PressableProps,
  type ViewStyle,
} from "react-native";
import { colors } from "@/theme/tokens";
import { labelOnWhite, typography } from "@/theme/typography";

type Variant = "primary" | "ghost" | "outline";

type Props = PressableProps & {
  label: string;
  variant?: Variant;
  style?: ViewStyle;
};

export function Button({ label, variant = "primary", style, disabled, ...rest }: Props) {
  const isPrimary = variant === "primary";
  const isOutline = variant === "outline";

  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      style={({ pressed }) => [
        styles.base,
        isPrimary && styles.primary,
        isOutline && styles.outline,
        variant === "ghost" && styles.ghost,
        pressed && styles.pressed,
        disabled && styles.disabled,
        style,
      ]}
      {...rest}
    >
      <Text
        style={[
          typography.label,
          { fontSize: 12 },
          isPrimary ? { color: colors.black } : { color: colors.smoke },
          isOutline && { color: colors.smoke },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function CheckBox({ checked }: { checked: boolean }) {
  return (
    <View style={[styles.check, checked && styles.checkOn]}>
      {checked ? (
        <Text style={{ color: colors.black, fontSize: 12, fontFamily: "PixelOperatorMono" }}>✓</Text>
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
  base: {
    height: 48,
    alignItems: "center",
    justifyContent: "center",
  },
  primary: {
    backgroundColor: colors.white,
  },
  outline: {
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: colors.rule,
  },
  ghost: {
    backgroundColor: "transparent",
  },
  pressed: {
    opacity: 0.85,
  },
  disabled: {
    opacity: 0.4,
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
    backgroundColor: colors.white,
    borderColor: colors.white,
  },
  invertedCheck: {
    backgroundColor: colors.white,
    alignItems: "center",
    justifyContent: "center",
  },
  checkMark: {
    width: 8,
    height: 4,
    borderLeftWidth: 2,
    borderBottomWidth: 2,
    borderColor: colors.black,
    transform: [{ rotate: "-45deg" }, { translateY: -1 }],
  },
});

export { labelOnWhite };
