import { FlatList, Pressable, Text, TextInput, View, StyleSheet } from "react-native";
import { router } from "expo-router";
import { IconClock, IconLock, IconPlus, IconSearch } from "@/components/icons";
import { Avatar } from "@/components/ui/Avatar";
import { Screen } from "@/components/ui/Screen";
import { ScreenHeader } from "@/components/ui/ScreenHeader";
import { chats, type ChatPreview } from "@/data/mock";
import { colors } from "@/theme/tokens";
import { typography } from "@/theme/typography";

function ChatRow({ item }: { item: ChatPreview }) {
  return (
    <Pressable
      onPress={() =>
        router.push({
          pathname: "/conversation/[id]",
          params: { id: item.id, name: item.name, group: item.group ? "1" : "0" },
        })
      }
      style={styles.row}
    >
      <Avatar initials={item.initials} group={item.group} />
      <View style={styles.meta}>
        <View style={styles.top}>
          <Text style={[typography.body, { fontSize: 15, color: colors.white }]}>{item.name}</Text>
          <Text style={[typography.mono, { fontSize: 11, color: colors.ghost }]}>{item.time}</Text>
        </View>
        <View style={styles.previewRow}>
          {item.locked ? <IconLock size={15} /> : null}
          {item.disappearing ? <IconClock size={13} /> : null}
          <Text style={[typography.body, styles.preview]} numberOfLines={1}>
            {item.preview}
          </Text>
        </View>
      </View>
      {item.unread ? (
        <View style={styles.badge}>
          <Text style={[typography.mono, { fontSize: 11, color: colors.black }]}>{item.unread}</Text>
        </View>
      ) : (
        <View style={{ width: 20 }} />
      )}
    </Pressable>
  );
}

export default function ChatListScreen() {
  return (
    <Screen>
      <ScreenHeader
        title="Messages"
        right={
          <Pressable
            onPress={() => router.push("/new-chat")}
            accessibilityLabel="New message"
            style={styles.iconBtn}
          >
            <IconPlus />
          </Pressable>
        }
      />
      <View style={styles.searchWrap}>
        <View style={styles.search}>
          <IconSearch />
          <TextInput
            placeholder="Search"
            placeholderTextColor={colors.steel}
            style={[typography.mono, styles.searchInput]}
          />
        </View>
      </View>
      <FlatList
        data={chats}
        keyExtractor={(c) => c.id}
        renderItem={({ item }) => <ChatRow item={item} />}
        showsVerticalScrollIndicator={false}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  iconBtn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
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
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.iron,
  },
  meta: {
    flex: 1,
    minWidth: 0,
  },
  top: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
  },
  previewRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 3,
  },
  preview: {
    flex: 1,
    fontSize: 13,
    color: colors.smoke,
  },
  badge: {
    width: 20,
    height: 20,
    backgroundColor: colors.white,
    alignItems: "center",
    justifyContent: "center",
  },
});
