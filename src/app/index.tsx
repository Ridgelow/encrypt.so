import { useEffect, useState } from "react";
import { View, ActivityIndicator } from "react-native";
import { Redirect } from "expo-router";
import { loadSession } from "@/services/session";
import { colors } from "@/theme/tokens";

/** Skip the boot splash while testing — jump straight to chats or welcome. */
export default function EntryScreen() {
  const [href, setHref] = useState<"/chats" | "/welcome" | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadSession().then((session) => {
      if (cancelled) return;
      setHref(session ? "/chats" : "/welcome");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!href) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.black, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={colors.smoke} />
      </View>
    );
  }

  return <Redirect href={href} />;
}
