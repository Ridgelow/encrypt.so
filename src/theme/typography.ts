import { StyleSheet, TextStyle } from "react-native";
import { colors, fonts } from "./tokens";

export const typography = StyleSheet.create({
  wordmark: {
    fontFamily: fonts.wordmark,
    textTransform: "uppercase",
    color: colors.white,
  },
  display: {
    fontFamily: fonts.display,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.8,
    color: colors.white,
  },
  body: {
    fontFamily: fonts.sans,
    color: colors.chalk,
  },
  bodyMedium: {
    fontFamily: fonts.sansMedium,
    color: colors.chalk,
  },
  label: {
    fontFamily: fonts.sansMedium,
    fontSize: 11,
    letterSpacing: 1.5,
    textTransform: "uppercase",
    color: colors.smoke,
  },
  mono: {
    fontFamily: fonts.mono,
    color: colors.chalk,
  },
});

export const labelOnWhite: TextStyle = {
  ...typography.label,
  fontSize: 12,
  color: colors.black,
};
