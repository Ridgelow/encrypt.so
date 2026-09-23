import "../../global.css";

import { useEffect } from "react";
import { View, ActivityIndicator } from "react-native";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useFonts, Barlow_400Regular, Barlow_500Medium } from "@expo-google-fonts/barlow";
import { SairaCondensed_600SemiBold } from "@expo-google-fonts/saira-condensed";
import * as SplashScreen from "expo-splash-screen";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { usePushLifecycle } from "@/services/push";
import { colors } from "@/theme/tokens";

SplashScreen.preventAutoHideAsync().catch(() => undefined);

export default function RootLayout() {
  usePushLifecycle();
  const [loaded] = useFonts({
    Hacked: require("../../assets/fonts/HACKED.ttf"),
    PixelOperatorMono: require("../../assets/fonts/PixelOperatorMono.ttf"),
    Barlow_400Regular,
    Barlow_500Medium,
    SairaCondensed_600SemiBold,
  });

  useEffect(() => {
    if (loaded) {
      SplashScreen.hideAsync().catch(() => undefined);
    }
  }, [loaded]);

  if (!loaded) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.black, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={colors.smoke} />
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.black }}>
      <SafeAreaProvider>
        <View style={{ flex: 1, backgroundColor: colors.black }}>
          <StatusBar style="light" />
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: colors.black },
              // No white edge/shadow under the swipe-back gesture
              animation: "simple_push",
              gestureEnabled: true,
              fullScreenGestureEnabled: true,
              fullScreenGestureShadowEnabled: false,
            }}
          >
            {/* Messages is the app root after onboarding — no swipe-back into auth. */}
            <Stack.Screen
              name="chats"
              options={{
                gestureEnabled: false,
                fullScreenGestureEnabled: false,
                animation: "none",
              }}
            />
            <Stack.Screen name="index" options={{ gestureEnabled: false, fullScreenGestureEnabled: false }} />
            <Stack.Screen name="welcome" options={{ gestureEnabled: false, fullScreenGestureEnabled: false }} />
            <Stack.Screen name="phone" options={{ gestureEnabled: false, fullScreenGestureEnabled: false }} />
            <Stack.Screen name="verify" options={{ gestureEnabled: false, fullScreenGestureEnabled: false }} />
            <Stack.Screen name="keygen" options={{ gestureEnabled: false, fullScreenGestureEnabled: false }} />
            <Stack.Screen name="profile" options={{ gestureEnabled: false, fullScreenGestureEnabled: false }} />
          </Stack>
        </View>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
