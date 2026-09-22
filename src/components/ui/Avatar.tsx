import { Text, View, StyleSheet } from "react-native";
import { colors } from "@/theme/tokens";
import { typography } from "@/theme/typography";
import { IconPeople } from "@/components/icons";

type Props = {
  initials?: string;
  size?: number;
  group?: boolean;
};

export function Avatar({ initials, size = 48, group }: Props) {
  return (
    <View style={[styles.base, { width: size, height: size }]}>
      {group ? (
        <IconPeople size={Math.round(size * 0.42)} />
      ) : (
        <Text style={[typography.mono, { fontSize: Math.round(size * 0.33), color: colors.chalk }]}>
          {initials}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    backgroundColor: colors.graphite,
    borderWidth: 1,
    borderColor: colors.rule,
    alignItems: "center",
    justifyContent: "center",
  },
});
