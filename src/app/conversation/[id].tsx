import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View, StyleSheet } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { ChatComposer, MessageBubble } from "@/components/chat/MessageBubble";
import { AttachmentSheet, DisappearingTimerSheet } from "@/components/chat/Sheets";
import { IconLock, IconPeople } from "@/components/icons";
import { Screen } from "@/components/ui/Screen";
import { ScreenHeader } from "@/components/ui/ScreenHeader";
import { chats, groupThread, samThread, type Message } from "@/data/mock";
import {
  decryptFromPeer,
  encryptForPeer,
  ensureSessionWithUser,
  isPeerUserId,
  type OpaqueEnvelope,
} from "@/e2ee";
import { configuredApiOrigin, createMessagingClient, type CiphertextMessage } from "@/services/api";
import { ciphertextToEnvelope, sendDisappearingCiphertext } from "@/services/ciphertext";
import {
  expireAtForChoice,
  isExpired,
  loadTimerChoice,
  purgeDelay,
  saveTimerChoice,
  systemLineForTimer,
} from "@/services/disappear";
import { openSecureMessageCache } from "@/services/messageCache";
import { loadSession } from "@/services/session";
import { colors } from "@/theme/tokens";
import { typography } from "@/theme/typography";

type ThreadItem = Message & { envelope?: OpaqueEnvelope; sealed?: boolean };

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function clock(at = Date.now()): string {
  const now = new Date(at);
  return `${now.getHours()}:${String(now.getMinutes()).padStart(2, "0")}`;
}

function clientId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `local-${Date.now()}`;
}

function openingThread(isGroup: boolean, peerUserId: string | null): ThreadItem[] {
  if (isGroup) return groupThread;
  if (peerUserId) {
    return [{ id: "e2ee", kind: "system", text: "Messages are end-to-end encrypted" }];
  }
  return samThread;
}

function tryEnvelope(ciphertext: string): OpaqueEnvelope | null {
  try {
    return ciphertextToEnvelope(ciphertext);
  } catch {
    return null;
  }
}

async function rememberPlaintext(input: {
  id: string;
  conversationId: string;
  plaintext: string;
  createdAt: number;
  expireAt: number | null;
}): Promise<void> {
  const cache = await openSecureMessageCache();
  if (!cache) return;
  await cache.save({
    id: input.id,
    conversationId: input.conversationId,
    plaintext: input.plaintext,
    createdAt: input.createdAt,
    ...(input.expireAt != null ? { expireAt: input.expireAt } : {}),
  });
}

export default function ConversationScreen() {
  const params = useLocalSearchParams<{ id: string; name?: string; group?: string; userId?: string }>();
  const id = firstParam(params.id);
  const name = firstParam(params.name);
  const group = firstParam(params.group);
  const userId = firstParam(params.userId);
  const isGroup = group === "1" || id === "design-crit" || id === "hackrice";
  const title = name ?? (isGroup ? "Design Crit" : "Sam");
  const peerUserId = isPeerUserId(userId) ? userId : isPeerUserId(id) ? id : null;
  const chat = chats.find((item) => item.id === id);

  const [messages, setMessages] = useState<ThreadItem[]>(() => openingThread(isGroup, peerUserId));
  const [draft, setDraft] = useState("");
  const [attachOpen, setAttachOpen] = useState(false);
  const [timerOpen, setTimerOpen] = useState(false);
  const [timer, setTimer] = useState("Off");
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const conversationIdRef = useRef<string | null>(null);

  useEffect(() => {
    setMessages(openingThread(isGroup, peerUserId));
    setDraft("");
    conversationIdRef.current = null;
    setTimer("Off");
  }, [id, isGroup, peerUserId]);

  useEffect(() => {
    const chatId = id ?? peerUserId;
    if (!chatId) return;
    let cancelled = false;
    void loadTimerChoice(chatId).then((label) => {
      if (!cancelled && label) setTimer(label);
    });
    return () => {
      cancelled = true;
    };
  }, [id, peerUserId]);

  const sealedKey = messages
    .filter((message) => message.kind === "text" && message.sealed && message.envelope)
    .map((message) => message.id)
    .join(",");

  useEffect(() => {
    if (!sealedKey) return;
    let cancelled = false;
    const pending = messagesRef.current.filter(
      (message): message is ThreadItem & { kind: "text"; envelope: OpaqueEnvelope } =>
        message.kind === "text" && message.sealed === true && message.envelope !== undefined,
    );
    void (async () => {
      const cache = await openSecureMessageCache();
      for (const message of pending) {
        let text = "Message unavailable";
        try {
          text = await decryptFromPeer(message.envelope);
          if (message.kind === "text") {
            await cache?.save({
              id: message.id,
              conversationId: conversationIdRef.current ?? id ?? message.id,
              plaintext: text,
              createdAt: Date.now(),
              ...(typeof message.expireAt === "number" ? { expireAt: message.expireAt } : {}),
            });
          }
        } catch {
          text = "Message unavailable";
        }
        if (cancelled) return;
        setMessages((current) =>
          current.map((item) => (item.id === message.id ? { ...item, text, sealed: false } : item)),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sealedKey, id]);

  useEffect(() => {
    if (!peerUserId || isGroup) return;
    let cancelled = false;
    void (async () => {
      const origin = configuredApiOrigin();
      const session = await loadSession();
      if (!origin || !session || cancelled) return;
      try {
        const client = createMessagingClient({ baseUrl: origin });
        const conversation = await client.createConversation(session.sessionToken, peerUserId);
        conversationIdRef.current = conversation.id;
        const page = await client.listMessages(session.sessionToken, conversation.id, { limit: 50 });
        const cache = await openSecureMessageCache();
        await cache?.purgeExpired();
        const cached = new Map((await cache?.list(conversation.id) ?? []).map((item) => [item.id, item]));
        const incoming: ThreadItem[] = [];
        for (const row of page.messages) {
          const item = await rowToThread(row, session.userId, cached.get(row.id)?.plaintext);
          if (!item) {
            await cache?.remove(row.id);
            continue;
          }
          if (item.from === "them" && item.text !== "Message unavailable") {
            await cache?.save({
              id: row.id,
              conversationId: conversation.id,
              plaintext: item.text,
              createdAt: row.createdAt,
              senderDeviceId: row.senderDeviceId,
              contentType: row.contentType,
              ...(row.expireAt != null ? { expireAt: row.expireAt } : {}),
            });
          }
          incoming.push(item);
        }
        if (cancelled) return;
        setMessages((current) => {
          const banner =
            current.find((message) => message.id === "e2ee") ??
            ({ id: "e2ee", kind: "system", text: "Messages are end-to-end encrypted" } as const);
          const notes = current.filter((message) => message.kind === "system" && message.id !== "e2ee");
          const incomingIds = new Set(incoming.map((message) => message.id));
          const pending = current.filter((message) => message.kind === "text" && !incomingIds.has(message.id));
          return [banner, ...notes, ...incoming, ...pending];
        });
      } catch {
        console.warn("[encrypt] ciphertext history stayed on the server");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [peerUserId, isGroup]);

  const purgeIds = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    const drop = new Set(ids);
    setMessages((current) => current.filter((item) => !drop.has(item.id)));
    void openSecureMessageCache().then(async (cache) => {
      if (!cache) return;
      for (const messageId of ids) await cache.remove(messageId);
    });
  }, []);

  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    const due: string[] = [];
    for (const message of messages) {
      if (message.kind !== "text") continue;
      const delay = purgeDelay(message.expireAt);
      if (delay == null) continue;
      if (delay === 0) {
        due.push(message.id);
        continue;
      }
      timers.push(setTimeout(() => purgeIds([message.id]), delay));
    }
    if (due.length > 0) purgeIds(due);
    return () => {
      for (const timerId of timers) clearTimeout(timerId);
    };
  }, [messages, purgeIds]);

  function selectTimer(next: string) {
    if (next === timer) return;
    setTimer(next);
    const chatId = id ?? peerUserId;
    if (chatId) void saveTimerChoice(chatId, next);
    setMessages((current) => [
      ...current,
      { id: `timer-${Date.now()}`, kind: "system", text: systemLineForTimer(next) },
    ]);
  }

  function send() {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    const expireAt = expireAtForChoice(timer) ?? null;
    const createdAt = Date.now();
    const localId = `local-${createdAt}`;
    const local: ThreadItem = {
      id: localId,
      kind: "text",
      from: "me",
      text,
      time: clock(createdAt),
      receipts: "✓",
      expireAt,
    };
    setMessages((current) => [...current, local]);
    const cacheConversation = conversationIdRef.current ?? id ?? peerUserId ?? "local";

    if (!peerUserId || isGroup) {
      void rememberPlaintext({
        id: localId,
        conversationId: cacheConversation,
        plaintext: text,
        createdAt,
        expireAt,
      });
      return;
    }

    void (async () => {
      try {
        await ensureSessionWithUser(peerUserId);
        const envelope = await encryptForPeer(peerUserId, text);
        const origin = configuredApiOrigin();
        const session = await loadSession();
        let messageId = localId;
        let conversationId = cacheConversation;
        if (origin && session) {
          const client = createMessagingClient({ baseUrl: origin });
          const posted = await sendDisappearingCiphertext({
            client,
            token: session.sessionToken,
            peerUserId,
            envelope,
            clientId: clientId(),
            ...(expireAt != null ? { expireAt } : {}),
          });
          messageId = posted.id;
          conversationId = posted.conversationId;
          conversationIdRef.current = posted.conversationId;
        }
        await rememberPlaintext({
          id: messageId,
          conversationId,
          plaintext: text,
          createdAt,
          expireAt,
        });
        setMessages((current) =>
          current.map((item) =>
            item.id === localId ? { ...item, id: messageId, envelope, receipts: "✓✓" } : item,
          ),
        );
      } catch {
        console.warn("[encrypt] message stayed on this device");
        await rememberPlaintext({
          id: localId,
          conversationId: cacheConversation,
          plaintext: text,
          createdAt,
          expireAt,
        });
      }
    })();
  }

  return (
    <Screen>
      <ScreenHeader
        title={title}
        subtitle={isGroup ? "4 members" : "End-to-end encrypted"}
        onBack={() => router.back()}
        right={
          <Pressable
            onPress={() =>
              !isGroup
                ? router.push({
                    pathname: "/safety/[id]",
                    params: {
                      id: peerUserId ?? id ?? "sam",
                      name: title,
                      ...(peerUserId ? { userId: peerUserId } : {}),
                      ...(chat?.initials ? { initials: chat.initials } : {}),
                    },
                  })
                : undefined
            }
            accessibilityLabel={isGroup ? "Group info" : "Safety number"}
            style={styles.iconBtn}
          >
            {isGroup ? <IconPeople /> : <IconLock />}
          </Pressable>
        }
      />
      <ScrollView contentContainerStyle={styles.thread} showsVerticalScrollIndicator={false}>
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
      </ScrollView>
      {timer !== "Off" ? (
        <Text style={[typography.mono, styles.timerHint]}>{systemLineForTimer(timer)}</Text>
      ) : null}
      <ChatComposer
        value={draft}
        onChangeText={setDraft}
        onAttach={() => setAttachOpen(true)}
        onTimer={() => setTimerOpen(true)}
        onSend={send}
      />
      <AttachmentSheet visible={attachOpen} onClose={() => setAttachOpen(false)} />
      <DisappearingTimerSheet
        visible={timerOpen}
        onClose={() => setTimerOpen(false)}
        selected={timer}
        onSelect={selectTimer}
      />
    </Screen>
  );
}

async function rowToThread(
  row: CiphertextMessage,
  localUserId: string,
  cachedPlaintext: string | undefined,
): Promise<(ThreadItem & { kind: "text" }) | null> {
  if (isExpired(row.expireAt)) return null;
  const envelope = tryEnvelope(row.ciphertext);
  if (!envelope) {
    return {
      id: row.id,
      kind: "text",
      from: "them",
      text: "Message unavailable",
      time: clock(row.createdAt),
      expireAt: row.expireAt,
    };
  }
  const mine = envelope.senderUserId === localUserId;
  let text = "Message unavailable";
  if (mine) {
    text = cachedPlaintext ?? "Encrypted message";
  } else {
    try {
      text = await decryptFromPeer(envelope);
    } catch {
      text = "Message unavailable";
    }
  }
  return {
    id: row.id,
    kind: "text",
    from: mine ? "me" : "them",
    text,
    time: clock(row.createdAt),
    receipts: mine ? "✓✓" : undefined,
    expireAt: row.expireAt,
  };
}

const styles = StyleSheet.create({
  thread: {
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 4,
  },
  iconBtn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  timerHint: {
    textAlign: "center",
    fontSize: 10.5,
    color: colors.steel,
    paddingBottom: 6,
  },
});
