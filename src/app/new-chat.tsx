import { useState } from "react";
import { FlatList, Pressable, Text, TextInput, View, StyleSheet } from "react-native";
import { router } from "expo-router";
import { IconPeople, IconSearch } from "@/components/icons";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Screen } from "@/components/ui/Screen";
import { ScreenHeader } from "@/components/ui/ScreenHeader";
import { contacts } from "@/data/mock";
import { parsePeerShare, rememberPeerName } from "@/services/contacts";
import { touchInboxThread } from "@/services/inbox";
import { colors } from "@/theme/tokens";
import { typography } from "@/theme/typography";

export default function NewChatScreen() {
  const [peerPaste, setPeerPaste] = useState("");
  const [peerName, setPeerName] = useState("");
  const [note, setNote] = useState("");

  function openLiveChat() {
    const parsed = parsePeerShare(peerPaste);
    if (!parsed) {
      setNote("paste the other device's user id (UUID)");
      return;
    }
    const label = peerName.trim() || parsed.name;
    if (label) void rememberPeerName(parsed.userId, label);
    void touchInboxThread({
      peerUserId: parsed.userId,
      name: label,
      preview: "End-to-end encrypted",
    });
    setNote("");
    router.push({
      pathname: "/conversation/[id]",
      params: {
        id: parsed.userId,
        name: label || parsed.userId.slice(0, 8),
        userId: parsed.userId,
      },
    });
  }

  return (
    <Screen>
      <ScreenHeader title="New Message" onBack={() => router.back()} />
      <View style={styles.liveBox}>
        <Text style={[typography.label, { fontSize: 10 }]}>Live encrypted chat</Text>
        <Text style={[typography.body, styles.liveHelp]}>
          Paste the share from the other device (name + user id). Both devices must finish key
          upload before messages sync.
        </Text>
        <View style={styles.peerField}>
          <TextInput
            value={peerName}
            onChangeText={setPeerName}
            placeholder="Their name (optional)"
            placeholderTextColor={colors.steel}
            style={[typography.mono, styles.peerInput]}
          />
        </View>
        <View style={styles.peerField}>
          <TextInput
            value={peerPaste}
            onChangeText={setPeerPaste}
            placeholder="name + UUID, or UUID alone"
            placeholderTextColor={colors.steel}
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            style={[typography.mono, styles.peerInput, { minHeight: 44, paddingVertical: 10 }]}
          />
        </View>
        {note ? <Text style={[typography.mono, styles.note]}>{note}</Text> : null}
        <View style={{ marginTop: 12 }}>
          <Button label="Open encrypted chat" onPress={openLiveChat} />
        </View>
      </View>
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
      <Text style={[typography.label, styles.section]}>Mock contacts (local only)</Text>
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
  liveBox: {
    marginHorizontal: 18,
    marginTop: 12,
    padding: 14,
    backgroundColor: colors.ash,
    borderWidth: 1,
    borderColor: colors.white,
    gap: 8,
  },
  liveHelp: {
    fontSize: 13,
    lineHeight: 18,
    color: colors.smoke,
  },
  peerField: {
    minHeight: 44,
    backgroundColor: colors.graphite,
    borderWidth: 1,
    borderColor: colors.rule,
    paddingHorizontal: 12,
    justifyContent: "center",
  },
  peerInput: {
    fontSize: 12,
    color: colors.chalk,
    padding: 0,
  },
  note: {
    fontSize: 11,
    color: colors.smoke,
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
