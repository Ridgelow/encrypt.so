import { FlatList, Pressable, Text, TextInput, View, StyleSheet } from "react-native";
import { router } from "expo-router";
import { IconPeople, IconSearch } from "@/components/icons";
import { Avatar } from "@/components/ui/Avatar";
import { Screen } from "@/components/ui/Screen";
import { ScreenHeader } from "@/components/ui/ScreenHeader";
import { contacts } from "@/data/mock";
import { colors } from "@/theme/tokens";
import { typography } from "@/theme/typography";

export default function NewChatScreen() {
  return (
    <Screen>
      <ScreenHeader title="New Message" onBack={() => router.back()} />
      <View style={styles.searchWrap}>
        <View style={styles.search}>
          <IconSearch />
          <TextInput
            placeholder="Search contacts"
            placeholderTextColor={colors.steel}
            style={[typography.mono, styles.searchInput]}
          />
        </View>
      </View>
      <Pressable onPress={() => router.push("/new-group")} style={styles.groupRow}>
        <View style={styles.groupIcon}>
          <IconPeople color={colors.black} />
        </View>
        <Text style={[typography.body, { fontSize: 15, color: colors.white }]}>New Group</Text>
      </Pressable>
      <Text style={[typography.label, styles.section]}>Contacts</Text>
      <FlatList
        data={contacts}
        keyExtractor={(c) => c.id}
        renderItem={({ item }) => (
          <Pressable
            onPress={() =>
              router.push({
                pathname: "/conversation/[id]",
                params: {
                  id: item.userId ?? item.id,
                  name: item.name.split(" ")[0],
                  ...(item.userId ? { userId: item.userId } : {}),
                },
              })
            }
            style={styles.row}
          >
            <Avatar initials={item.initials} size={44} />
            <Text style={[typography.body, { fontSize: 15, color: colors.white }]}>{item.name}</Text>
          </Pressable>
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  searchWrap: {
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  search: {
    height: 38,
    backgroundColor: colors.ash,
    borderWidth: 1,
    borderColor: colors.rule,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
  },
  searchInput: {
    flex: 1,
    fontSize: 13,
    color: colors.chalk,
    padding: 0,
  },
  groupRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.iron,
  },
  groupIcon: {
    width: 44,
    height: 44,
    backgroundColor: colors.white,
    alignItems: "center",
    justifyContent: "center",
  },
  section: {
    fontSize: 10,
    paddingHorizontal: 18,
    paddingTop: 14,
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
});
