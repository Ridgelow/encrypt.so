import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  Keyboard,
  Platform,
  Pressable,
  Text,
  StyleSheet,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import { ChatComposer, MessageBubble } from "@/components/chat/MessageBubble";
import { AttachmentSheet, DisappearingTimerSheet, type AttachmentPick } from "@/components/chat/Sheets";
import { IconLock, IconPeople } from "@/components/icons";
import { ScreenHeader } from "@/components/ui/ScreenHeader";
import { chats, groupThread, samThread, type Message } from "@/data/mock";
import {
  decryptFromPeer,
  encryptForPeer,
  ensurePublishedKeys,
  ensureSessionWithUser,
  isPeerUserId,
  type OpaqueEnvelope,
} from "@/e2ee";
import { ATTACHMENT_CONTENT_TYPE, bytesToBase64, formatByteSize, openDecryptedAttachment } from "@/e2ee/attachment";
import { configuredApiOrigin, createMessagingClient, isApiConfigured, type CiphertextMessage } from "@/services/api";
import { stageEncryptedAttachment } from "@/services/attachments";
import { postBodyForEnvelope, readOpaqueCiphertext, sendDisappearingCiphertext } from "@/services/ciphertext";
import { peerDisplayName, rememberPeerName, shortUserId } from "@/services/contacts";
import { inboxConversationId, touchGroupThread, touchInboxThread } from "@/services/inbox";
import {
  expireAtForChoice,
  isExpired,
  loadTimerChoice,
  purgeDelay,
  saveTimerChoice,
  systemLineForTimer,
} from "@/services/disappear";
import { liveGroupEnabled, openGroupChat, type GroupChat } from "@/services/groupChat";
import { liveChatEnabled, openLiveChat, type LiveChat, type LiveThreadMessage } from "@/services/liveChat";
import { openSecureMessageCache, type CachedMessage } from "@/services/messageCache";
import { pickAttachment, type PickedAttachment } from "@/services/pickAttachment";
import { loadSession } from "@/services/session";
import { newClientId } from "@/lib/id";
import { colors } from "@/theme/tokens";
import { typography } from "@/theme/typography";

type ThreadItem = Message & { envelope?: OpaqueEnvelope; sealed?: boolean; contentType?: string };

function sendFailureLine(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Could not deliver — message stayed on this device";
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function clock(at = Date.now()): string {
  const now = new Date(at);
  return `${now.getHours()}:${String(now.getMinutes()).padStart(2, "0")}`;
}

function clientId(): string {
  return newClientId();
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
    ...(item.senderUserId
      ? {
          sender: item.senderUserId.slice(0, 8),
          senderInitials: item.senderUserId.slice(0, 2).toUpperCase(),
        }
      : {}),
  };
}

function cachedToThread(row: CachedMessage): ThreadItem | null {
  if (isExpired(row.expireAt ?? null)) return null;
  if (row.contentType === ATTACHMENT_CONTENT_TYPE) {
    const label =
      row.plaintext && !row.plaintext.includes('"key"') ? row.plaintext : "Encrypted attachment";
    return {
      id: row.id,
      kind: "file",
      from: row.from ?? "me",
      name: label,
      size: "",
      time: clock(row.createdAt),
      receipts: (row.from ?? "me") === "me" ? "✓✓" : undefined,
      expireAt: row.expireAt,
      contentType: ATTACHMENT_CONTENT_TYPE,
    };
  }
  return {
    id: row.id,
    kind: "text",
    from: row.from ?? "me",
    text: row.plaintext,
    time: clock(row.createdAt),
    receipts: (row.from ?? "me") === "me" ? "✓✓" : undefined,
    ...(row.expireAt != null ? { expireAt: row.expireAt } : {}),
  };
}

/** Instant open: show on-device plaintext without waiting on the network. */
async function hydrateFromCache(conversationKeys: string[]): Promise<ThreadItem[]> {
  const unique = [...new Set(conversationKeys.filter(Boolean))];
  if (unique.length === 0) return [];
  const cache = await openSecureMessageCache().catch(() => null);
  if (!cache) return [];
  try {
    await cache.purgeExpired();
  } catch {
    // Still try to read.
  }
  const seen = new Set<string>();
  const rows: CachedMessage[] = [];
  for (const key of unique) {
    const listed = await cache.list(key).catch(() => []);
    for (const row of listed) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
    }
  }
  rows.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const items: ThreadItem[] = [];
  for (const row of rows) {
    const item = cachedToThread(row);
    if (item) items.push(item);
  }
  return items;
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

function openingThread(isGroup: boolean, peerUserId: string | null, liveGroup: boolean): ThreadItem[] {
  if (liveGroup || peerUserId) {
    return [{ id: "e2ee", kind: "system", text: "Messages are end-to-end encrypted" }];
  }
  if (isGroup) return groupThread;
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
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id: string; name?: string; group?: string; userId?: string }>();
  const id = firstParam(params.id);
  const name = firstParam(params.name);
  const group = firstParam(params.group);
  const userId = firstParam(params.userId);
  const isGroup = group === "1" || id === "design-crit" || id === "hackrice";
  const peerUserId = isGroup ? null : isPeerUserId(userId) ? userId : isPeerUserId(id) ? id : null;
  const liveGroupId = isGroup && isPeerUserId(id) ? id : null;
  const chat = chats.find((item) => item.id === id);
  const [title, setTitle] = useState(
    () => name ?? (isGroup ? chat?.name ?? "Group" : peerUserId ? shortUserId(peerUserId) : chat?.name ?? "Chat"),
  );
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (name && name.toLowerCase() !== "peer" && peerUserId) {
        await rememberPeerName(peerUserId, name);
      }
      if (peerUserId) {
        const label = await peerDisplayName(peerUserId, name);
        if (!cancelled) setTitle(label);
        void touchInboxThread({ peerUserId, name: label, preview: "End-to-end encrypted" });
        return;
      }
      if (liveGroupId) {
        void touchGroupThread({ groupId: liveGroupId, title: name });
      }
      if (!cancelled) {
        setTitle(name ?? (isGroup ? chat?.name ?? "Group" : chat?.name ?? "Chat"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chat?.name, isGroup, liveGroupId, name, peerUserId]);

  const [messages, setMessages] = useState<ThreadItem[]>(() => openingThread(isGroup, peerUserId, Boolean(liveGroupId)));
  const [memberCount, setMemberCount] = useState<number | null>(null);
  const [animateIds, setAnimateIds] = useState(() => new Set<string>());
  const liveRef = useRef<Promise<LiveChat | null>>(Promise.resolve(null));
  const groupRef = useRef<Promise<GroupChat | null>>(Promise.resolve(null));
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
  const animateIdsRef = useRef(animateIds);
  animateIdsRef.current = animateIds;
  const entranceReadyRef = useRef(false);

  function markAnimated(id: string) {
    setAnimateIds((current) => {
      if (current.has(id)) return current;
      const next = new Set(current);
      next.add(id);
      return next;
    });
  }

  function shown(item: ThreadItem): ThreadItem {
    if (item.kind === "system") return item;
    return openedAttachments.current.get(item.id) ?? item;
  }

  useEffect(() => {
    chatKeyRef.current = `${id ?? ""}:${peerUserId ?? ""}:${liveGroupId ?? ""}:${isGroup ? "g" : "d"}`;
    setMessages(openingThread(isGroup, peerUserId, Boolean(liveGroupId)));
    setMemberCount(null);
    setDraft("");
    conversationIdRef.current = null;
    setTimer("Off");
    setAnimateIds(new Set());
    entranceReadyRef.current = false;

    let cancelled = false;
    void (async () => {
      const keys = [peerUserId, liveGroupId, id].filter((value): value is string => Boolean(value));
      if (peerUserId) {
        const known = await inboxConversationId(peerUserId);
        if (known) keys.push(known);
      }
      const cached = await hydrateFromCache(keys);
      if (cancelled || cached.length === 0) return;
      setMessages((current) => {
        const banner = current.find((message) => message.id === "e2ee");
        return banner ? [banner, ...cached] : cached;
      });
    })();

    const ready = setTimeout(() => {
      entranceReadyRef.current = true;
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(ready);
    };
  }, [id, isGroup, liveGroupId, peerUserId]);

  useEffect(() => {
    const show = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow",
      (e) => setKeyboardHeight(e.endCoordinates.height),
    );
    const hide = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide",
      () => setKeyboardHeight(0),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  const threadData = useMemo(() => [...messages].reverse(), [messages]);
  const composerPad = keyboardHeight > 0 ? 8 : Math.max(insets.bottom, 10);

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
        await ensurePublishedKeys();
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
            if (entranceReadyRef.current) markAnimated(thread.id);
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
        if (peer) {
          void touchInboxThread({
            peerUserId: peer,
            conversationId: chat.conversationId,
            preview: "End-to-end encrypted",
          });
        }
        setMessages((current) => {
          const opening = current.filter((message) => message.kind === "system");
          const live = chat.history.filter((item) => !isExpired(item.expireAt)).map((item) => shown(toThread(item)));
          const seen = new Set(live.map((message) => message.id));
          const kept = current.filter((message) => message.kind !== "system" && !seen.has(message.id));
          return [...(opening.length ? opening : openingThread(isGroup, peer, false)), ...live, ...kept];
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

  useEffect(() => {
    if (!liveGroupEnabled({ groupId: liveGroupId, apiConfigured: isApiConfigured(), hasSession: true })) {
      groupRef.current = Promise.resolve(null);
      return;
    }
    const groupId = liveGroupId;
    if (!groupId) return;
    let cancelled = false;
    const pending = (async (): Promise<GroupChat | null> => {
      const session = await loadSession();
      const origin = configuredApiOrigin();
      if (!session || !origin || cancelled) return null;
      try {
        const chat = await openGroupChat({
          httpBase: origin,
          sessionToken: session.sessionToken,
          localUserId: session.userId,
          groupId,
          messaging: createMessagingClient({ baseUrl: origin }),
          onMessage(item) {
            if (isExpired(item.expireAt)) return;
            const thread = shown(toThread(item));
            if (entranceReadyRef.current) markAnimated(thread.id);
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
        setMemberCount(chat.memberUserIds.length);
        void touchGroupThread({
          groupId: chat.conversationId,
          title: chat.title,
          preview: "Encrypted group",
        });
        setMessages((current) => {
          const opening = current.filter((message) => message.kind === "system");
          const live = chat.history.filter((item) => !isExpired(item.expireAt)).map((item) => shown(toThread(item)));
          const seen = new Set(live.map((message) => message.id));
          const kept = current.filter((message) => message.kind !== "system" && !seen.has(message.id));
          return [...(opening.length ? opening : openingThread(true, null, true)), ...live, ...kept];
        });
        return chat;
      } catch (err) {
        console.warn("[realtime] group stayed on this device", err instanceof Error ? err.message : "");
        return null;
      }
    })();
    const settled = pending.catch((err) => {
      console.warn("[realtime] group stayed on this device", err instanceof Error ? err.message : "");
      return null;
    });
    groupRef.current = settled;
    return () => {
      cancelled = true;
      void settled.then((chat) => chat?.close());
      if (groupRef.current === settled) groupRef.current = Promise.resolve(null);
    };
  }, [liveGroupId]);

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
    markAnimated(localId);
    const cacheConversation = conversationIdRef.current ?? id ?? peerUserId ?? "local";

    if (liveGroupId) {
      void (async () => {
        try {
          const live = await groupRef.current;
          if (!live) throw new Error("offline");
          const published = await live.publish(text, { expireAt, createdAt });
          setMessages((current) =>
            current.map((item) => (item.id === localId ? { ...item, id: published.id, receipts: "✓✓" } : item)),
          );
        } catch {
          console.warn("[encrypt] group message stayed on this device");
          await rememberPlaintext({
            id: localId,
            conversationId: cacheConversation,
            plaintext: text,
            createdAt,
            expireAt,
          });
        }
      })();
      return;
    }

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
        await ensurePublishedKeys();
        await ensureSessionWithUser(peerUserId);
        const envelope = await encryptForPeer(peerUserId, text);
        const live = await liveRef.current;
        if (live) {
          const published = await live.publish(envelope, text, { expireAt, createdAt });
          void touchInboxThread({
            peerUserId,
            conversationId: live.conversationId,
            preview: text,
          });
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
          void touchInboxThread({
            peerUserId,
            conversationId: posted.conversationId,
            preview: text,
          });
        } else {
          throw new Error("Not signed in or API URL missing");
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
      } catch (error) {
        const line = sendFailureLine(error);
        console.warn("[encrypt] message stayed on this device", line, error);
        setMessages((current) => [
          ...current.map((item) => (item.id === localId ? { ...item, receipts: "!" } : item)),
          { id: `err-${Date.now()}`, kind: "system", text: line },
        ]);
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
      markAnimated(localId);
      if (localOnly || !peerUserId) return;
      try {
        await ensurePublishedKeys();
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
    <View style={[styles.root, { paddingBottom: keyboardHeight }]}>
      <ScreenHeader
        title={title}
        subtitle={
          liveGroupId ? `${memberCount ?? "…"} members` : isGroup ? "4 members" : "End-to-end encrypted"
        }
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
      <FlatList
        style={styles.flex}
        data={threadData}
        keyExtractor={(item) => item.id}
        inverted
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.thread}
        renderItem={({ item }) => (
          <MessageBubble message={item} animate={animateIds.has(item.id)} />
        )}
      />
      {timer !== "Off" ? (
        <Text style={[typography.mono, styles.timerHint]}>{systemLineForTimer(timer)}</Text>
      ) : null}
      <View style={{ paddingBottom: composerPad }}>
        <ChatComposer
          value={draft}
          onChangeText={setDraft}
          onAttach={() => setAttachOpen(true)}
          onTimer={() => setTimerOpen(true)}
          onSend={send}
        />
      </View>
      <AttachmentSheet visible={attachOpen} onClose={() => setAttachOpen(false)} onPick={sendAttachment} />
      <DisappearingTimerSheet
        visible={timerOpen}
        onClose={() => setTimerOpen(false)}
        selected={timer}
        onSelect={selectTimer}
      />
    </View>
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
  root: {
    flex: 1,
    backgroundColor: colors.black,
  },
  flex: {
    flex: 1,
  },
  thread: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    flexGrow: 1,
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
