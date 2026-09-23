import { useCallback, useEffect, useState } from "react";
import {
  BackHandler,
  FlatList,
  Pressable,
  Text,
  TextInput,
  View,
  StyleSheet,
  Share,
} from "react-native";
import { router, useFocusEffect, useNavigation } from "expo-router";
import { IconClock, IconLock, IconPlus, IconSearch } from "@/components/icons";
import { Avatar } from "@/components/ui/Avatar";
import { Screen } from "@/components/ui/Screen";
import { ScreenHeader } from "@/components/ui/ScreenHeader";
import type { ChatPreview } from "@/data/mock";
import { ensurePublishedKeys } from "@/e2ee";
import { configuredApiOrigin, createMessagingClient, isApiConfigured } from "@/services/api";
import { loadInboxPreviews, loadLocalInboxPreviews, shortUserId } from "@/services/inbox";
import { loadDisplayName } from "@/services/profile";
import { loadSession } from "@/services/session";
import { colors } from "@/theme/tokens";
import { typography } from "@/theme/typography";

function ChatRow({ item }: { item: ChatPreview }) {
  return (
    <Pressable
      onPress={() =>
        router.push({
          pathname: "/conversation/[id]",
          params: {
            id: item.id,
            name: item.name,
            group: item.group ? "1" : "0",
            ...(item.userId ? { userId: item.userId } : {}),
          },
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
  const navigation = useNavigation();
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [myName, setMyName] = useState<string | null>(null);
  const [rows, setRows] = useState<ChatPreview[]>([]);
  const [keysDetail, setKeysDetail] = useState("Checking keys…");
  const [keysReady, setKeysReady] = useState(false);

  const refreshInbox = useCallback(async () => {
    const session = await loadSession();
    const display = await loadDisplayName();
    setMyUserId(session?.userId ?? null);
    setMyName(display);

    if (!session || !isApiConfigured()) {
      setRows(await loadLocalInboxPreviews());
      return;
    }
    const origin = configuredApiOrigin();
    if (!origin) {
      setRows(await loadLocalInboxPreviews());
      return;
    }
    try {
      const client = createMessagingClient({ baseUrl: origin });
      const listed = await client.listConversations(session.sessionToken);
      const previews = await loadInboxPreviews({
        localUserId: session.userId,
        remote: listed.conversations,
      });
      setRows(previews);
    } catch {
      setRows(await loadLocalInboxPreviews());
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener("hardwareBackPress", () => true);
      let cancelled = false;
      void (async () => {
        await refreshInbox();
        const status = await ensurePublishedKeys();
        if (cancelled) return;
        setKeysReady(status.ready);
        setKeysDetail(status.detail);
      })();
      return () => {
        cancelled = true;
        sub.remove();
      };
    }, [refreshInbox]),
  );

  useEffect(() => {
    const unsub = navigation.addListener("beforeRemove", (e) => {
      e.preventDefault();
    });
    return unsub;
  }, [navigation]);

  async function shareUserId() {
    if (!myUserId) return;
    const message = myName ? `${myName}\n${myUserId}` : myUserId;
    await Share.share({ message });
  }

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
      {myUserId ? (
        <Pressable
          style={styles.myId}
          onPress={() => void shareUserId()}
          accessibilityLabel="Share your user id"
        >
          <Text style={[typography.label, { fontSize: 9 }]}>
            {myName ? `${myName} · your user id — tap to share` : "Your user id — tap to share"}
          </Text>
          <Text style={[typography.mono, styles.myIdValue]} numberOfLines={1} selectable>
            {myUserId}
          </Text>
        </Pressable>
      ) : null}
      <Pressable
        style={[styles.keysRow, keysReady ? styles.keysOk : styles.keysBad]}
        onPress={() => {
          setKeysDetail("Publishing…");
          void ensurePublishedKeys().then((status) => {
            setKeysReady(status.ready);
            setKeysDetail(status.detail);
          });
        }}
        accessibilityLabel="Encryption key status"
      >
        <Text style={[typography.mono, styles.keysText]}>
          {keysReady ? `✓ ${keysDetail}` : `! ${keysDetail} — tap to retry`}
        </Text>
      </Pressable>
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
        data={rows}
        keyExtractor={(c) => `${c.group ? "g" : "d"}:${c.userId ?? c.id}`}
        renderItem={({ item }) => <ChatRow item={item} />}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          <Text style={[typography.mono, styles.hint]}>
            No chats yet. Tap + and paste a user id to start an encrypted conversation.
            {myUserId ? ` · you ${shortUserId(myUserId)}` : ""}
          </Text>
        }
        ListHeaderComponent={
          rows.length > 0 ? (
            <Text style={[typography.mono, styles.hint]}>
              Live encrypted chats.
              {myUserId ? ` · you ${shortUserId(myUserId)}` : ""}
            </Text>
          ) : null
        }
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
  myId: {
    marginHorizontal: 18,
    marginTop: 8,
    padding: 12,
    backgroundColor: colors.ash,
    borderWidth: 1,
    borderColor: colors.rule,
    gap: 4,
  },
  myIdValue: {
    fontSize: 11,
    color: colors.chalk,
  },
  keysRow: {
    marginHorizontal: 18,
    marginTop: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderWidth: 1,
  },
  keysOk: {
    borderColor: colors.rule,
    backgroundColor: colors.ash,
  },
  keysBad: {
    borderColor: colors.white,
    backgroundColor: colors.graphite,
  },
  keysText: {
    fontSize: 11,
    color: colors.chalk,
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
  hint: {
    fontSize: 11,
    color: colors.ghost,
    paddingHorizontal: 18,
    paddingBottom: 10,
    lineHeight: 16,
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
    gap: 4,
  },
  top: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  },
  previewRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  preview: {
    flex: 1,
    fontSize: 13,
    color: colors.smoke,
  },
  badge: {
    minWidth: 20,
    height: 20,
    paddingHorizontal: 6,
    backgroundColor: colors.white,
    alignItems: "center",
    justifyContent: "center",
  },
});
