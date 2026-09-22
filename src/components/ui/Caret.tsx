import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { colors } from "@/theme/tokens";

/** Hard steps blink — BLACKOUT tick verb */
export function Caret({ height = 14 }: { height?: number }) {
  const [on, setOn] = useState(true);

  useEffect(() => {
    const id = setInterval(() => setOn((v) => !v), 550);
    return () => clearInterval(id);
  }, []);

  return <View style={[styles.caret, { height, opacity: on ? 1 : 0 }]} />;
}

const styles = StyleSheet.create({
  caret: {
    width: 8,
    backgroundColor: colors.white,
    marginLeft: 3,
  },
});
