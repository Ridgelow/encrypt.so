import { useState } from "react";
import { Pressable, Text, TextInput, View, StyleSheet } from "react-native";
import { router } from "expo-router";
import { IconCamera, IconPlus } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { Caret } from "@/components/ui/Caret";
import { Screen } from "@/components/ui/Screen";
import { ScreenHeader } from "@/components/ui/ScreenHeader";
import { colors } from "@/theme/tokens";
import { typography } from "@/theme/typography";

export default function ProfileSetupScreen() {
  const [name, setName] = useState("");
  const [about, setAbout] = useState("");

  return (
    <Screen>
      <ScreenHeader />
      <View style={styles.body}>
        <Text style={[typography.display, { fontSize: 24 }]}>Set up your profile</Text>
        <Text style={[typography.body, styles.help]}>
          This is what contacts see. It's never shared with anyone outside your conversations.
        </Text>
        <View style={styles.avatarWrap}>
          <View style={styles.avatar}>
            <IconCamera size={22} />
          </View>
          <Pressable style={styles.plus} accessibilityLabel="Add photo">
            <IconPlus size={20} color={colors.black} />
          </Pressable>
        </View>
        <Text style={[typography.label, { fontSize: 10 }]}>Display name</Text>
        <View style={[styles.field, styles.fieldLive]}>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Your name"
            placeholderTextColor={colors.steel}
            style={[typography.mono, styles.input]}
            autoFocus
          />
          {!name ? <Caret /> : null}
        </View>
        <Text style={[typography.label, { fontSize: 10, marginTop: 18 }]}>About (optional)</Text>
        <View style={styles.field}>
          <TextInput
            value={about}
            onChangeText={setAbout}
            placeholder="Short status"
            placeholderTextColor={colors.steel}
            style={[typography.mono, styles.input]}
          />
        </View>
      </View>
      <View style={styles.footer}>
        <Button label="Continue" onPress={() => router.replace("/chats")} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: {
    flex: 1,
    paddingHorizontal: 22,
    paddingTop: 24,
  },
  help: {
    fontSize: 13.5,
    lineHeight: 20,
    color: colors.smoke,
    marginTop: 8,
  },
  avatarWrap: {
    alignSelf: "center",
    marginVertical: 28,
  },
  avatar: {
    width: 96,
    height: 96,
    backgroundColor: colors.ash,
    borderWidth: 1,
    borderColor: colors.rule,
    alignItems: "center",
    justifyContent: "center",
  },
  plus: {
    position: "absolute",
    bottom: -6,
    right: -6,
    width: 28,
    height: 28,
    backgroundColor: colors.white,
    alignItems: "center",
    justifyContent: "center",
  },
  field: {
    height: 46,
    backgroundColor: colors.ash,
    borderWidth: 1,
    borderColor: colors.rule,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    marginTop: 8,
  },
  fieldLive: {
    borderColor: colors.white,
  },
  input: {
    flex: 1,
    fontSize: 14,
    color: colors.chalk,
    padding: 0,
  },
  footer: {
    paddingHorizontal: 22,
    paddingBottom: 16,
  },
});
