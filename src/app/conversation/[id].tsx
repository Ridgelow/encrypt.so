import { useState } from "react";
import { Pressable, ScrollView, View, StyleSheet } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { ChatComposer, MessageBubble } from "@/components/chat/MessageBubble";
import { AttachmentSheet, DisappearingTimerSheet } from "@/components/chat/Sheets";
import { IconLock, IconPeople } from "@/components/icons";
import { Screen } from "@/components/ui/Screen";
import { ScreenHeader } from "@/components/ui/ScreenHeader";
import { groupThread, samThread } from "@/data/mock";

export default function ConversationScreen() {
  const { id, name, group } = useLocalSearchParams<{ id: string; name?: string; group?: string }>();
  const isGroup = group === "1" || id === "design-crit" || id === "hackrice";
  const title = name ?? (isGroup ? "Design Crit" : "Sam");
  const messages = isGroup ? groupThread : samThread;

  const [draft, setDraft] = useState("");
  const [attachOpen, setAttachOpen] = useState(false);
  const [timerOpen, setTimerOpen] = useState(false);
  const [timer, setTimer] = useState("1 week");

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
        onSend={() => setDraft("")}
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
