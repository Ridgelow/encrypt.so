import { useMemo, useState } from "react";
import { FlatList, Pressable, Text, TextInput, View, StyleSheet } from "react-native";
import { router } from "expo-router";
import { IconCamera, IconCheck } from "@/components/icons";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Screen } from "@/components/ui/Screen";
import { ScreenHeader } from "@/components/ui/ScreenHeader";
import { contacts } from "@/data/mock";
import { colors } from "@/theme/tokens";
import { typography } from "@/theme/typography";

export default function NewGroupScreen() {
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set(["alex", "jordan", "sam"]));

  const count = useMemo(() => selected.size, [selected]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <Screen>
      <ScreenHeader title="New Group" onBack={() => router.back()} />
      <View style={styles.header}>
        <View style={styles.photo}>
          <IconCamera size={26} />
        </View>
        <View style={styles.nameField}>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Group name"
            placeholderTextColor={colors.steel}
            style={[typography.mono, { flex: 1, fontSize: 14, color: colors.chalk, padding: 0 }]}
          />
        </View>
      </View>
      <View style={styles.membersHead}>
        <Text style={[typography.label, { fontSize: 10 }]}>Members</Text>
        <Text style={[typography.mono, { fontSize: 11, color: colors.ghost }]}>{count} selected</Text>
      </View>
      <FlatList
        data={contacts}
        keyExtractor={(c) => c.id}
        renderItem={({ item }) => {
          const on = selected.has(item.id);
          return (
            <Pressable onPress={() => toggle(item.id)} style={styles.row}>
              <Avatar initials={item.initials} size={44} />
              <Text style={[typography.body, { flex: 1, fontSize: 15, color: colors.white }]}>{item.name}</Text>
              <View style={[styles.check, on && styles.checkOn]}>
                {on ? <IconCheck size={14} /> : null}
              </View>
            </Pressable>
          );
        }}
      />
      <View style={styles.footer}>
        <Button
          label="Create Group"
          onPress={() =>
            router.replace({
              pathname: "/conversation/[id]",
              params: { id: "design-crit", name: name || "Design Crit", group: "1" },
            })
          }
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 18,
    paddingTop: 20,
  },
  photo: {
    width: 56,
    height: 56,
    backgroundColor: colors.ash,
    borderWidth: 1,
    borderColor: colors.rule,
    alignItems: "center",
    justifyContent: "center",
  },
  nameField: {
    flex: 1,
    height: 44,
    backgroundColor: colors.ash,
    borderWidth: 1,
    borderColor: colors.rule,
    paddingHorizontal: 14,
    justifyContent: "center",
  },
  membersHead: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingTop: 22,
    paddingBottom: 6,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 18,
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderBottomColor: colors.iron,
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
  footer: {
    paddingHorizontal: 18,
    paddingVertical: 16,
  },
});
