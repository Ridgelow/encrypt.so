import { Pressable, Text, TextInput, View, StyleSheet } from "react-native";
import {
  IconAttach,
  IconClock,
  IconFile,
  IconImage,
  IconLock,
  IconSend,
} from "@/components/icons";
import { Avatar } from "@/components/ui/Avatar";
import type { Message } from "@/data/mock";
import { colors } from "@/theme/tokens";
import { typography } from "@/theme/typography";

export function MessageBubble({ message }: { message: Message }) {
  if (message.kind === "system") {
    if (message.text.includes("end-to-end")) {
      return (
        <View style={styles.banner}>
          <IconLock size={15} />
          <Text style={[typography.label, { fontSize: 9.5 }]}>{message.text}</Text>
        </View>
      );
    }
    return <Text style={[typography.mono, styles.systemLine]}>{message.text}</Text>;
  }

  const mine = message.from === "me";

  if (message.kind === "image") {
    return (
      <View style={[styles.row, mine && styles.rowMine]}>
        <View>
          <View style={styles.imagePlaceholder}>
            <IconImage />
          </View>
          {message.time ? (
            <Text style={[typography.mono, styles.meta, mine && styles.metaMine]}>
              {message.time}
              {message.receipts ? ` ${message.receipts}` : ""}
            </Text>
          ) : null}
        </View>
      </View>
    );
  }

  if (message.kind === "file") {
    return (
      <View style={[styles.row, mine && styles.rowMine]}>
        <View style={styles.fileBubble}>
          <View style={styles.fileIcon}>
            <IconFile size={22} />
          </View>
          <View>
            <Text style={[typography.body, { fontSize: 13.5, color: colors.chalk }]}>{message.name}</Text>
            <Text style={[typography.mono, { fontSize: 10, color: colors.ghost, marginTop: 2 }]}>
              {message.size}
            </Text>
          </View>
        </View>
      </View>
    );
  }

  const bubble = (
    <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleThem]}>
      <Text style={[styles.text, mine && styles.textMine]}>{message.text}</Text>
      {message.time || message.expireAt ? (
        <Text style={[typography.mono, styles.meta, mine && styles.metaMine]}>
          {message.time ?? ""}
          {message.receipts ? ` ${message.receipts}` : ""}
          {message.expireAt ? " ttl" : ""}
        </Text>
      ) : null}
    </View>
  );

  if (message.sender) {
    return (
      <View style={[styles.row, styles.groupRow]}>
        <Avatar initials={message.senderInitials} size={28} />
        <View style={{ flexShrink: 1 }}>
          <Text style={[typography.mono, styles.sender]}>{message.sender}</Text>
          {bubble}
        </View>
      </View>
    );
  }

  return <View style={[styles.row, mine && styles.rowMine]}>{bubble}</View>;
}

export function ChatComposer({
  onAttach,
  onTimer,
  onSend,
  value,
  onChangeText,
}: {
  onAttach: () => void;
  onTimer: () => void;
  onSend: () => void;
  value: string;
  onChangeText: (t: string) => void;
}) {
  return (
    <View style={styles.composer}>
      <Pressable onPress={onAttach} style={styles.iconBtn} accessibilityLabel="Attach">
        <IconAttach />
      </Pressable>
      <View style={styles.input}>
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder="Message"
          placeholderTextColor={colors.ghost}
          style={[typography.mono, styles.inputText]}
        />
      </View>
      <Pressable onPress={onTimer} style={styles.iconBtn} accessibilityLabel="Disappearing messages">
        <IconClock />
      </Pressable>
      <Pressable onPress={onSend} style={styles.send} accessibilityLabel="Send">
        <IconSend />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 14,
  },
  systemLine: {
    textAlign: "center",
    fontSize: 10.5,
    color: colors.steel,
    marginVertical: 14,
  },
  row: {
    marginBottom: 10,
    flexDirection: "row",
  },
  rowMine: {
    justifyContent: "flex-end",
  },
  groupRow: {
    alignItems: "flex-end",
    gap: 8,
  },
  sender: {
    fontSize: 10,
    color: colors.ghost,
    marginLeft: 2,
    marginBottom: 3,
  },
  bubble: {
    maxWidth: 248,
    paddingHorizontal: 13,
    paddingVertical: 10,
  },
  bubbleThem: {
    backgroundColor: colors.ash,
    borderWidth: 1,
    borderColor: colors.rule,
  },
  bubbleMine: {
    backgroundColor: colors.white,
  },
  text: {
    fontFamily: "Barlow_400Regular",
    fontSize: 14.5,
    lineHeight: 21,
    color: colors.chalk,
  },
  textMine: {
    color: colors.black,
  },
  meta: {
    fontSize: 10,
    color: colors.steel,
    marginTop: 5,
  },
  metaMine: {
    textAlign: "right",
  },
  imagePlaceholder: {
    width: 200,
    height: 140,
    backgroundColor: colors.graphite,
    borderWidth: 1,
    borderColor: colors.rule,
    alignItems: "center",
    justifyContent: "center",
  },
  fileBubble: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.ash,
    borderWidth: 1,
    borderColor: colors.rule,
    paddingHorizontal: 13,
    paddingVertical: 10,
    maxWidth: 248,
  },
  fileIcon: {
    width: 34,
    height: 34,
    backgroundColor: colors.iron,
    alignItems: "center",
    justifyContent: "center",
  },
  composer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: colors.rule,
  },
  iconBtn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  input: {
    flex: 1,
    height: 40,
    backgroundColor: colors.iron,
    borderWidth: 1,
    borderColor: colors.rule,
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  inputText: {
    fontSize: 14,
    color: colors.chalk,
    padding: 0,
  },
  send: {
    width: 40,
    height: 40,
    backgroundColor: colors.white,
    alignItems: "center",
    justifyContent: "center",
  },
});
