import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, View, StyleSheet } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { ChatComposer, MessageBubble } from "@/components/chat/MessageBubble";
import { AttachmentSheet, DisappearingTimerSheet } from "@/components/chat/Sheets";
import { IconLock, IconPeople } from "@/components/icons";
import { Screen } from "@/components/ui/Screen";
import { ScreenHeader } from "@/components/ui/ScreenHeader";
import { groupThread, samThread, type Message } from "@/data/mock";
import { decryptFromPeer, encryptForPeer, ensureSessionWithUser, isPeerUserId, type OpaqueEnvelope } from "@/e2ee";

type ThreadItem = Message & { envelope?: OpaqueEnvelope; sealed?: boolean };

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function clock(): string {
  const now = new Date();
  return `${now.getHours()}:${String(now.getMinutes()).padStart(2, "0")}`;
}

function openingThread(isGroup: boolean, peerUserId: string | null): ThreadItem[] {
  if (isGroup) return groupThread;
  if (peerUserId) {
    return [{ id: "e2ee", kind: "system", text: "Messages are end-to-end encrypted" }];
  }
  return samThread;
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

  const [messages, setMessages] = useState<ThreadItem[]>(() => openingThread(isGroup, peerUserId));
  const [draft, setDraft] = useState("");
  const [attachOpen, setAttachOpen] = useState(false);
  const [timerOpen, setTimerOpen] = useState(false);
  const [timer, setTimer] = useState("1 week");
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  useEffect(() => {
    setMessages(openingThread(isGroup, peerUserId));
    setDraft("");
  }, [id, isGroup, peerUserId]);

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
      for (const message of pending) {
        let text = "Message unavailable";
        try {
          text = await decryptFromPeer(message.envelope);
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
  }, [sealedKey]);

  function send() {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    const local: ThreadItem = {
      id: `local-${Date.now()}`,
      kind: "text",
      from: "me",
      text,
      time: clock(),
      receipts: "✓",
    };
    if (!peerUserId || isGroup) {
      setMessages((current) => [...current, local]);
      return;
    }
    void (async () => {
      try {
        await ensureSessionWithUser(peerUserId);
        const envelope = await encryptForPeer(peerUserId, text);
        setMessages((current) => [...current, { ...local, envelope }]);
      } catch {
        console.warn("[encrypt] message stayed on this device");
        setMessages((current) => [...current, local]);
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
                ? router.push({ pathname: "/safety/[id]", params: { id: id ?? "sam", name: title } })
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
        onSelect={setTimer}
      />
    </Screen>
  );
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
});
