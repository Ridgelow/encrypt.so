import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { Alert } from "react-native";
import { ATTACHMENT_MAX_PLAINTEXT, base64ToBytes } from "@/e2ee/attachment";

export type PickedAttachment = {
  bytes: Uint8Array;
  mime: string;
  name?: string;
  /** Local file URI for an on-device preview. This is never uploaded. */
  previewUri?: string;
};

async function readBytes(uri: string, base64?: string | null, file?: Blob | null): Promise<Uint8Array> {
  if (base64) return base64ToBytes(base64);
  if (file) return new Uint8Array(await file.arrayBuffer());
  const { File } = await import("expo-file-system");
  return new File(uri).bytes();
}

function tooLarge(bytes: Uint8Array): boolean {
  return bytes.byteLength < 1 || bytes.byteLength > ATTACHMENT_MAX_PLAINTEXT;
}

async function fromImage(kind: "photo" | "camera"): Promise<PickedAttachment | null> {
  if (kind === "camera") {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Camera access is required to send an encrypted photo.");
      return null;
    }
  } else {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Photo access is required to send an encrypted photo.");
      return null;
    }
  }

  const result =
    kind === "camera"
      ? await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.8, base64: true, exif: false })
      : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.8, base64: true, exif: false });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) return null;
  const bytes = await readBytes(asset.uri, asset.base64, asset.file ?? null);
  if (tooLarge(bytes)) {
    Alert.alert("That photo is too large to send encrypted.");
    return null;
  }
  const mime = asset.mimeType ?? "image/jpeg";
  return {
    bytes,
    mime,
    name: asset.fileName ?? undefined,
    previewUri: asset.uri,
  };
}

async function fromFile(): Promise<PickedAttachment | null> {
  const result = await DocumentPicker.getDocumentAsync({
    copyToCacheDirectory: true,
    multiple: false,
    base64: true,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) return null;
  const bytes = await readBytes(asset.uri, asset.base64, asset.file ?? null);
  if (tooLarge(bytes)) {
    Alert.alert("That file is too large to send encrypted.");
    return null;
  }
  const mime = asset.mimeType ?? "application/octet-stream";
  return {
    bytes,
    mime,
    name: asset.name,
    previewUri: mime.startsWith("image/") ? asset.uri : undefined,
  };
}

export async function pickAttachment(kind: "photo" | "camera" | "file"): Promise<PickedAttachment | null> {
  try {
    if (kind === "file") return await fromFile();
    return await fromImage(kind);
  } catch {
    Alert.alert("Could not read that file.");
    return null;
  }
}
