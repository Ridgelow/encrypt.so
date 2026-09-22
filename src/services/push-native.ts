import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { Platform } from "react-native";
import { DEVICE_KEY_RECORD_KEY } from "@/e2ee/record";
import { createExpoKeyValueStore, isDeviceKeyStoreAvailable } from "@/e2ee/expo-key-store";
import { createChunkedStore } from "@/e2ee/store";
import { createPushClient, isApiConfigured } from "@/services/api";
import {
  inboxConversationId,
  registrationBody,
  serverDeviceIdFromRecord,
  shouldOpenInboxFromLaunch,
} from "@/services/push-metadata";
import { loadSession } from "@/services/session";

const PUSH_CHANNEL_ID = "messages";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: false,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

function projectId(): string | null {
  const extra = Constants.expoConfig?.extra;
  const fromExtra =
    extra && typeof extra === "object" && "eas" in extra
      ? (extra as { eas?: { projectId?: unknown } }).eas?.projectId
      : undefined;
  if (typeof fromExtra === "string" && fromExtra.length > 0) return fromExtra;
  const fromEas = Constants.easConfig?.projectId;
  return typeof fromEas === "string" && fromEas.length > 0 ? fromEas : null;
}

async function readServerDeviceId(): Promise<string | null> {
  try {
    if (!(await isDeviceKeyStoreAvailable())) return null;
    const raw = await createChunkedStore(createExpoKeyValueStore()).getItem(DEVICE_KEY_RECORD_KEY);
    if (!raw) return null;
    return serverDeviceIdFromRecord(raw);
  } catch {
    return null;
  }
}

async function obtainExpoPushToken(): Promise<string | null> {
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync(PUSH_CHANNEL_ID, {
      name: "Messages",
      importance: Notifications.AndroidImportance.HIGH,
    });
  }

  const existing = await Notifications.getPermissionsAsync();
  let status = existing.status;
  if (status !== "granted") {
    const requested = await Notifications.requestPermissionsAsync();
    status = requested.status;
  }
  if (status !== "granted") return null;

  const id = projectId();
  if (!id) return null;
  const token = await Notifications.getExpoPushTokenAsync({ projectId: id });
  return token.data;
}

/** Permission, Expo push token, then POST /push/register. Errors do not surface to onboarding. */
export async function syncPushRegistration(): Promise<void> {
  if (Platform.OS !== "ios" && Platform.OS !== "android") return;
  if (!isApiConfigured()) return;

  let session: { sessionToken: string } | null = null;
  try {
    session = await loadSession();
  } catch {
    return;
  }
  if (!session) return;

  const origin = process.env.EXPO_PUBLIC_API_URL?.trim().replace(/\/$/, "");
  if (!origin) return;

  try {
    const expoPushToken = await obtainExpoPushToken();
    if (!expoPushToken) return;
    const deviceId = await readServerDeviceId();
    await createPushClient({ baseUrl: origin }).registerPushToken(
      session.sessionToken,
      registrationBody({
        expoPushToken,
        platform: Platform.OS,
        deviceId,
      }),
    );
  } catch {
    console.warn("[encrypt] push registration skipped");
  }
}

async function openInbox(notification: Notifications.Notification): Promise<void> {
  if (!inboxConversationId(notification.request.content.data)) return;
  const session = await loadSession().catch(() => null);
  if (!session) return;
  router.push("/chats");
}

/** Opens the chat list when a metadata push is tapped. Returns the unsubscribe. */
export function listenForPushOpens(): () => void {
  try {
    const last = Notifications.getLastNotificationResponse();
    if (
      last?.notification &&
      shouldOpenInboxFromLaunch({
        data: last.notification.request.content.data,
        notificationDate: last.notification.date,
      })
    ) {
      void openInbox(last.notification);
    }
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      void openInbox(response.notification);
    });
    return () => subscription.remove();
  } catch {
    return () => undefined;
  }
}
