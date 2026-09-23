import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, StyleSheet } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { ChatComposer, MessageBubble } from "@/components/chat/MessageBubble";
import { AttachmentSheet, DisappearingTimerSheet, type AttachmentPick } from "@/components/chat/Sheets";
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
import { ATTACHMENT_CONTENT_TYPE, bytesToBase64, formatByteSize, openDecryptedAttachment } from "@/e2ee/attachment";
import { configuredApiOrigin, createMessagingClient, isApiConfigured, type CiphertextMessage } from "@/services/api";
import { stageEncryptedAttachment } from "@/services/attachments";
import { postBodyForEnvelope, readOpaqueCiphertext, sendDisappearingCiphertext } from "@/services/ciphertext";
import {
  expireAtForChoice,
  isExpired,
  loadTimerChoice,
  purgeDelay,
  saveTimerChoice,
  systemLineForTimer,
} from "@/services/disappear";
import { liveChatEnabled, openLiveChat, type LiveChat, type LiveThreadMessage } from "@/services/liveChat";
import { openSecureMessageCache } from "@/services/messageCache";
import { pickAttachment, type PickedAttachment } from "@/services/pickAttachment";
import { loadSession } from "@/services/session";
import { colors } from "@/theme/tokens";
import { typography } from "@/theme/typography";

type ThreadItem = Message & { envelope?: OpaqueEnvelope; sealed?: boolean; contentType?: string };

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

function toThread(item: LiveThreadMessage): ThreadItem {
  if (item.contentType === ATTACHMENT_CONTENT_TYPE) {
    return {
      id: item.id,
      kind: "file",
      from: item.from,
      name: item.text || "Encrypted attachment",
      size: "",
      time: clock(item.createdAt),
      receipts: item.from === "me" ? "✓✓" : undefined,
      envelope: item.envelope,
      expireAt: item.expireAt,
      contentType: item.contentType,
      sealed: item.from === "them" && item.envelope != null,
    };
  }
  return {
    id: item.id,
    kind: "text",
    from: item.from,
    text: item.text,
    time: clock(item.createdAt),
    receipts: item.from === "me" ? "✓✓" : undefined,
    envelope: item.envelope,
    ...(item.expireAt != null ? { expireAt: item.expireAt } : {}),
  };
}

function localAttachment(picked: PickedAttachment, id: string, receipts: string, expireAt: number | null): ThreadItem {
  const time = clock();
  if (picked.mime.startsWith("image/") && picked.previewUri) {
    return { id, kind: "image", from: "me", time, receipts, uri: picked.previewUri, expireAt };
  }
  return {
    id,
    kind: "file",
    from: "me",
    name: picked.name ?? "File",
    size: formatByteSize(picked.bytes.byteLength),
    time,
    receipts,
    expireAt,
  };
}

function openingThread(isGroup: boolean, peerUserId: string | null): ThreadItem[] {
  if (isGroup) return groupThread;
  if (peerUserId) {
    return [{ id: "e2ee", kind: "system", text: "Messages are end-to-end encrypted" }];
  }
  return samThread;
}

function tryEnvelope(ciphertext: string): OpaqueEnvelope | null {
  return readOpaqueCiphertext(ciphertext);
}

function mergeHttpHistory(current: ThreadItem[], incoming: ThreadItem[]): ThreadItem[] {
  const banner: ThreadItem = current.find((message) => message.id === "e2ee") ?? {
    id: "e2ee",
    kind: "system",
    text: "Messages are end-to-end encrypted",
  };
  const notes = current.filter((message) => message.kind === "system" && message.id !== "e2ee");
  const incomingIds = new Set(incoming.map((message) => message.id));
  const pending = current.filter((message) => message.kind !== "system" && !incomingIds.has(message.id));
  return [banner, ...notes, ...incoming, ...pending];
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
    from: "me",
    ...(input.expireAt != null ? { expireAt: input.expireAt } : {}),
  });
}

async function loadHttpThread(input: {
  origin: string;
  token: string;
  localUserId: string;
  peerUserId: string;
}): Promise<{ conversationId: string; items: ThreadItem[] }> {
  const client = createMessagingClient({ baseUrl: input.origin });
  const conversation = await client.createConversation(input.token, input.peerUserId);
  const page = await client.listMessages(input.token, conversation.id, { limit: 50 });
  const cache = await openSecureMessageCache();
  await cache?.purgeExpired();
  const cached = new Map((await cache?.list(conversation.id) ?? []).map((item) => [item.id, item]));
  const incoming: ThreadItem[] = [];
  for (const row of page.messages) {
    const cachedPlaintext =
      (row.clientId ? cached.get(row.clientId)?.plaintext : undefined) ?? cached.get(row.id)?.plaintext;
    const item = await rowToThread(row, input.localUserId, cachedPlaintext);
    if (!item) {
      await cache?.remove(row.id);
      if (row.clientId) await cache?.remove(row.clientId);
      continue;
    }
    if (item.kind === "text" && item.from === "them" && item.text !== "Message unavailable") {
      await cache?.save({
        id: row.id,
        conversationId: conversation.id,
        plaintext: item.text,
        createdAt: row.createdAt,
        senderDeviceId: row.senderDeviceId,
        contentType: row.contentType,
        from: "them",
        ...(row.expireAt != null ? { expireAt: row.expireAt } : {}),
      });
    }
    incoming.push(item);
  }
  return { conversationId: conversation.id, items: incoming };
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
  const liveRef = useRef<Promise<LiveChat | null>>(Promise.resolve(null));
  const [draft, setDraft] = useState("");
  const [attachOpen, setAttachOpen] = useState(false);
  const [timerOpen, setTimerOpen] = useState(false);
  const [timer, setTimer] = useState("Off");
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const conversationIdRef = useRef<string | null>(null);
  const openingAttachments = useRef(new Set<string>());
  const openedAttachments = useRef(new Map<string, ThreadItem>());
  const chatKeyRef = useRef("");

  function shown(item: ThreadItem): ThreadItem {
    if (item.kind === "system") return item;
    return openedAttachments.current.get(item.id) ?? item;
  }

  useEffect(() => {
    chatKeyRef.current = `${id ?? ""}:${peerUserId ?? ""}:${isGroup ? "g" : "d"}`;
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

  useEffect(() => {
    if (!liveChatEnabled({ peerUserId, isGroup, apiConfigured: isApiConfigured(), hasSession: true })) {
      liveRef.current = Promise.resolve(null);
      return;
    }
    const peer = peerUserId;
    if (!peer) return;
    let cancelled = false;
    const pending = (async (): Promise<LiveChat | null> => {
      const session = await loadSession();
      const origin = configuredApiOrigin();
      if (!session || !origin || cancelled) return null;
      try {
        const chat = await openLiveChat({
          httpBase: origin,
          sessionToken: session.sessionToken,
          localUserId: session.userId,
          peerUserId: peer,
          messaging: createMessagingClient({ baseUrl: origin }),
          decrypt: decryptFromPeer,
          onMessage(item) {
            if (isExpired(item.expireAt)) return;
            const thread = shown(toThread(item));
            setMessages((current) =>
              current.some((message) => message.id === thread.id) ? current : [...current, thread],
            );
          },
        });
        if (cancelled) {
          chat.close();
          return null;
        }
        conversationIdRef.current = chat.conversationId;
        setMessages((current) => {
          const opening = current.filter((message) => message.kind === "system");
          const live = chat.history.filter((item) => !isExpired(item.expireAt)).map((item) => shown(toThread(item)));
          const seen = new Set(live.map((message) => message.id));
          const kept = current.filter((message) => message.kind !== "system" && !seen.has(message.id));
          return [...(opening.length ? opening : openingThread(isGroup, peer)), ...live, ...kept];
        });
        return chat;
      } catch (err) {
        console.warn("[realtime] staying on this device", err instanceof Error ? err.message : "");
        try {
          const loaded = await loadHttpThread({
            origin,
            token: session.sessionToken,
            localUserId: session.userId,
            peerUserId: peer,
          });
          if (cancelled) return null;
          conversationIdRef.current = loaded.conversationId;
          setMessages((current) => mergeHttpHistory(current, loaded.items).map(shown));
        } catch {
          console.warn("[encrypt] ciphertext history stayed on the server");
        }
        return null;
      }
    })();
    const settled = pending.catch((err) => {
      console.warn("[realtime] staying on this device", err instanceof Error ? err.message : "");
      return null;
    });
    liveRef.current = settled;
    return () => {
      cancelled = true;
      void settled.then((chat) => chat?.close());
      if (liveRef.current === settled) liveRef.current = Promise.resolve(null);
    };
  }, [isGroup, peerUserId]);

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
      if (message.kind === "system") continue;
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

  useEffect(() => {
    const pending = messages.filter(
      (message): message is ThreadItem & { kind: "file"; envelope: OpaqueEnvelope } =>
        message.kind === "file" &&
        message.sealed === true &&
        message.contentType === ATTACHMENT_CONTENT_TYPE &&
        message.envelope != null &&
        !openingAttachments.current.has(message.id),
    );
    if (pending.length === 0) return;
    const startedKey = chatKeyRef.current;
    for (const message of pending) openingAttachments.current.add(message.id);
    void (async () => {
      const session = await loadSession();
      const origin = configuredApiOrigin();
      const conversationId = conversationIdRef.current;
      if (!session || !origin || !conversationId) {
        for (const message of pending) openingAttachments.current.delete(message.id);
        return;
      }
      const client = createMessagingClient({ baseUrl: origin });
      for (const message of pending) {
        try {
          const plaintext = await decryptFromPeer(message.envelope);
          const opened = await openDecryptedAttachment(plaintext, (objectKey) =>
            client.downloadAttachment(session.sessionToken, conversationId, objectKey),
          );
          const preview =
            opened.mime.startsWith("image/") && opened.bytes.byteLength <= 8 * 1024 * 1024
              ? `data:${opened.mime};base64,${bytesToBase64(opened.bytes)}`
              : undefined;
          const time = message.time;
          const expireAt = message.expireAt;
          const next: ThreadItem = preview
            ? {
                id: message.id,
                kind: "image",
                from: message.from,
                time,
                uri: preview,
                expireAt,
                sealed: false,
              }
            : {
                id: message.id,
                kind: "file",
                from: message.from,
                name: opened.name ?? "File",
                size: formatByteSize(opened.bytes.byteLength),
                time,
                expireAt,
                sealed: false,
              };
          openedAttachments.current.set(message.id, next);
          if (chatKeyRef.current !== startedKey) continue;
          setMessages((current) => current.map((item) => (item.id === message.id ? next : item)));
        } catch {
          const failed: ThreadItem = {
            id: message.id,
            kind: "file",
            from: message.from,
            name: "Attachment unavailable",
            size: "",
            time: message.time,
            expireAt: message.expireAt,
            sealed: false,
          };
          openedAttachments.current.set(message.id, failed);
          if (chatKeyRef.current !== startedKey) continue;
          setMessages((current) => current.map((item) => (item.id === message.id ? failed : item)));
        }
      }
    })();
  }, [messages]);

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
        const live = await liveRef.current;
        if (live) {
          const published = await live.publish(envelope, text, { expireAt, createdAt });
          setMessages((current) =>
            current.map((item) =>
              item.id === localId ? { ...item, id: published.id, envelope, receipts: "✓✓" } : item,
            ),
          );
          return;
        }
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

  function sendAttachment(kind: AttachmentPick) {
    void (async () => {
      const picked = await pickAttachment(kind);
      if (!picked) return;
      const expireAt = expireAtForChoice(timer) ?? null;
      const createdAt = Date.now();
      const localId = clientId();
      const localOnly = !peerUserId || isGroup;
      setMessages((current) => {
        if (current.some((item) => item.id === localId)) return current;
        return [...current, localAttachment(picked, localId, localOnly ? "✓" : "…", expireAt)];
      });
      if (localOnly || !peerUserId) return;
      try {
        await ensureSessionWithUser(peerUserId);
        const session = await loadSession();
        const origin = configuredApiOrigin();
        if (!session || !origin) throw new Error("offline");
        const client = createMessagingClient({ baseUrl: origin });
        const live = await liveRef.current;
        let conversationId = live?.conversationId ?? conversationIdRef.current;
        if (!conversationId) {
          const conversation = await client.createConversation(session.sessionToken, peerUserId);
          conversationId = conversation.id;
          conversationIdRef.current = conversation.id;
        }
        const staged = await stageEncryptedAttachment({
          client,
          token: session.sessionToken,
          conversationId,
          bytes: picked.bytes,
          mime: picked.mime,
          name: picked.name,
          expireAt,
          encrypt: (plaintext) => encryptForPeer(peerUserId, plaintext),
        });
        if (live) {
          const published = await live.publish(staged.envelope, staged.label, {
            contentType: ATTACHMENT_CONTENT_TYPE,
            expireAt,
            createdAt,
          });
          setMessages((current) =>
            current.map((item) =>
              item.id === localId && item.kind !== "system" ? { ...item, id: published.id, receipts: "✓✓" } : item,
            ),
          );
          return;
        }
        const posted = await client.postMessage(
          session.sessionToken,
          conversationId,
          postBodyForEnvelope(staged.envelope, {
            clientId: localId,
            contentType: ATTACHMENT_CONTENT_TYPE,
            ...(expireAt != null ? { expireAt } : {}),
          }),
        );
        const cache = await openSecureMessageCache().catch(() => null);
        await cache?.save({
          id: localId,
          conversationId,
          plaintext: staged.label,
          createdAt,
          from: "me",
          contentType: ATTACHMENT_CONTENT_TYPE,
          ...(expireAt != null ? { expireAt } : {}),
        });
        setMessages((current) =>
          current.map((item) =>
            item.id === localId && item.kind !== "system" ? { ...item, id: posted.id, receipts: "✓✓" } : item,
          ),
        );
      } catch {
        console.warn("[encrypt] attachment stayed on this device");
        setMessages((current) =>
          current.map((item) =>
            item.id === localId && item.kind !== "system" ? { ...item, receipts: "!" } : item,
          ),
        );
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
      <AttachmentSheet visible={attachOpen} onClose={() => setAttachOpen(false)} onPick={sendAttachment} />
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
): Promise<ThreadItem | null> {
  if (isExpired(row.expireAt)) return null;
  if (row.contentType === ATTACHMENT_CONTENT_TYPE) {
    const envelope = tryEnvelope(row.ciphertext);
    const mine = envelope?.senderUserId === localUserId;
    const label =
      mine && cachedPlaintext && !cachedPlaintext.includes('"key"') ? cachedPlaintext : "Encrypted attachment";
    return {
      id: row.clientId ?? row.id,
      kind: "file",
      from: mine ? "me" : "them",
      name: label,
      size: "",
      time: clock(row.createdAt),
      receipts: mine ? "✓✓" : undefined,
      expireAt: row.expireAt,
      envelope: mine ? undefined : (envelope ?? undefined),
      contentType: row.contentType,
      sealed: !mine && envelope != null,
    };
  }
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
