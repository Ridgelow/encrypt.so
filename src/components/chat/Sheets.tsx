import { Modal, Pressable, Text, View, StyleSheet } from "react-native";
import { IconCamera, IconCheck, IconClose, IconFile, IconImage, IconPin } from "@/components/icons";
import { DISAPPEAR_LABELS } from "@/services/disappear";
import { colors } from "@/theme/tokens";
import { typography } from "@/theme/typography";

type SheetProps = {
  visible: boolean;
  onClose: () => void;
};

export function DisappearingTimerSheet({
  visible,
  onClose,
  selected = "Off",
  onSelect,
}: SheetProps & { selected?: string; onSelect?: (v: string) => void }) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <View style={styles.sheetHeader}>
            <Text style={[typography.display, { fontSize: 16 }]}>Disappearing Messages</Text>
            <Pressable onPress={onClose} accessibilityLabel="Close">
              <IconClose />
            </Pressable>
          </View>
          {DISAPPEAR_LABELS.map((opt) => {
            const active = opt === selected;
            return (
              <Pressable
                key={opt}
                onPress={() => {
                  onSelect?.(opt);
                  onClose();
                }}
                style={styles.row}
              >
                <Text style={[typography.body, { fontSize: 15, color: active ? colors.white : colors.chalk }]}>
                  {opt}
                </Text>
                {active ? (
                  <View style={styles.check}>
                    <IconCheck />
                  </View>
                ) : null}
              </Pressable>
            );
          })}
          <View style={{ height: 24 }} />
        </View>
      </View>
    </Modal>
  );
}

export function AttachmentSheet({ visible, onClose }: SheetProps) {
  const items = [
    { label: "Photo", icon: <IconImage /> },
    { label: "Camera", icon: <IconCamera /> },
    { label: "File", icon: <IconFile /> },
    { label: "Location", icon: <IconPin /> },
  ];

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={[styles.sheet, { paddingBottom: 28 }]}>
          <View style={styles.handle} />
          <View style={styles.sheetHeader}>
            <Text style={[typography.display, { fontSize: 16 }]}>Send</Text>
            <Pressable onPress={onClose} accessibilityLabel="Close">
              <IconClose />
            </Pressable>
          </View>
          <View style={styles.attachRow}>
            {items.map((item) => (
              <Pressable key={item.label} onPress={onClose} style={styles.attachItem}>
                <View style={styles.attachIcon}>{item.icon}</View>
                <Text style={[typography.label, { fontSize: 10 }]}>{item.label}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0,0,0,0.7)",
  },
  sheet: {
    backgroundColor: colors.ash,
    borderTopWidth: 1,
    borderTopColor: colors.rule,
  },
  handle: {
    alignSelf: "center",
    width: 36,
    height: 4,
    backgroundColor: colors.rule,
    marginTop: 10,
    marginBottom: 4,
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 22,
    paddingVertical: 8,
    paddingBottom: 14,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 22,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.iron,
  },
  check: {
    width: 20,
    height: 20,
    backgroundColor: colors.white,
    alignItems: "center",
    justifyContent: "center",
  },
  attachRow: {
    flexDirection: "row",
    justifyContent: "space-around",
    paddingHorizontal: 18,
  },
  attachItem: {
    alignItems: "center",
    gap: 10,
  },
  attachIcon: {
    width: 60,
    height: 60,
    backgroundColor: colors.ash,
    borderWidth: 1,
    borderColor: colors.rule,
    alignItems: "center",
    justifyContent: "center",
  },
});
