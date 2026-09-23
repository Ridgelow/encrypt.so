import { useMemo, useState } from "react";
import { FlatList, Pressable, Text, TextInput, View, StyleSheet } from "react-native";
import { router } from "expo-router";
import { IconCamera, IconCheck } from "@/components/icons";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Screen } from "@/components/ui/Screen";
import { ScreenHeader } from "@/components/ui/ScreenHeader";
import { isPeerUserId } from "@/e2ee";
import { contacts } from "@/data/mock";
import { configuredApiOrigin, createMessagingClient, isApiConfigured } from "@/services/api";
import { createLiveGroup } from "@/services/groupChat";
import { loadSession } from "@/services/session";
import { colors } from "@/theme/tokens";
import { typography } from "@/theme/typography";

export default function NewGroupScreen() {
  const [name, setName] = useState("");
  const [memberId, setMemberId] = useState("");
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set(["alex", "jordan", "sam"]));
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const api = isApiConfigured();

  const count = useMemo(() => selected.size + memberIds.length, [memberIds.length, selected]);

  function addMemberId() {
    const next = memberId.trim();
    if (!isPeerUserId(next) || memberIds.includes(next)) return;
    setMemberIds((current) => [...current, next]);
    setMemberId("");
    setError("");
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function createGroup() {
    if (creating) return;
    const title = name.trim() || "Design Crit";
    const peers = [
      ...memberIds,
      ...contacts.flatMap((contact) => (selected.has(contact.id) && contact.userId ? [contact.userId] : [])),
    ].filter((userId, index, all) => all.indexOf(userId) === index);
    const origin = configuredApiOrigin();
    if (api && origin && peers.length >= 2) {
      setCreating(true);
      setError("");
      try {
        const session = await loadSession();
        if (!session) {
          setError("Sign in to create an encrypted group");
          return;
        }
        const conversation = await createLiveGroup({
          origin,
          sessionToken: session.sessionToken,
          localUserId: session.userId,
          title,
          memberUserIds: peers,
          messaging: createMessagingClient({ baseUrl: origin }),
        });
        router.replace({
          pathname: "/conversation/[id]",
          params: { id: conversation.id, name: conversation.title ?? title, group: "1" },
        });
      } catch (err) {
        console.warn("[encrypt] group create stayed offline", err instanceof Error ? err.message : "");
        setError("Could not create the group");
      } finally {
        setCreating(false);
      }
      return;
    }
    router.replace({
      pathname: "/conversation/[id]",
      params: { id: "design-crit", name: title, group: "1" },
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
      {api ? (
        <View style={styles.idRow}>
          <TextInput
            value={memberId}
            onChangeText={setMemberId}
            placeholder="Member user id"
            placeholderTextColor={colors.steel}
            autoCapitalize="none"
            autoCorrect={false}
            style={[typography.mono, styles.idInput]}
          />
          <Pressable onPress={addMemberId} style={styles.addId}>
            <Text style={[typography.mono, { fontSize: 12, color: colors.black }]}>Add</Text>
          </Pressable>
        </View>
      ) : null}
      {memberIds.length > 0 ? (
        <Text style={[typography.mono, styles.idList]}>{memberIds.join("  ")}</Text>
      ) : null}
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
      {error ? <Text style={[typography.mono, styles.error]}>{error}</Text> : null}
      <View style={styles.footer}>
        <Button label={creating ? "Creating" : "Create Group"} onPress={() => void createGroup()} />
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
  idRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 18,
    paddingTop: 14,
  },
  idInput: {
    flex: 1,
    height: 40,
    backgroundColor: colors.ash,
    borderWidth: 1,
    borderColor: colors.rule,
    color: colors.chalk,
    fontSize: 12,
    paddingHorizontal: 12,
  },
  addId: {
    height: 40,
    paddingHorizontal: 14,
    backgroundColor: colors.white,
    alignItems: "center",
    justifyContent: "center",
  },
  idList: {
    fontSize: 10,
    color: colors.ghost,
    paddingHorizontal: 18,
    paddingTop: 8,
  },
  error: {
    fontSize: 11,
    color: colors.smoke,
    paddingHorizontal: 18,
    paddingTop: 8,
  },
  footer: {
    paddingHorizontal: 18,
    paddingVertical: 16,
  },
});
