import * as SecureStore from "expo-secure-store";
import { isPeerUserId } from "@/e2ee";

const BOOK_KEY = "encrypt.contactBook.v1";

type ContactBook = Record<string, string>;

async function readBook(): Promise<ContactBook> {
  const raw = await SecureStore.getItemAsync(BOOK_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: ContactBook = {};
    for (const [id, name] of Object.entries(parsed as Record<string, unknown>)) {
      if (isPeerUserId(id) && typeof name === "string" && name.trim()) {
        out[id] = name.trim().slice(0, 64);
      }
    }
    return out;
  } catch {
    return {};
  }
}

async function writeBook(book: ContactBook): Promise<void> {
  await SecureStore.setItemAsync(BOOK_KEY, JSON.stringify(book));
}

/** Short label when the peer has no saved display name. */
export function shortUserId(userId: string): string {
  return userId.slice(0, 8);
}

export async function rememberPeerName(userId: string, name: string): Promise<void> {
  if (!isPeerUserId(userId)) return;
  const trimmed = name.trim().slice(0, 64);
  if (!trimmed || trimmed.toLowerCase() === "peer") return;
  const book = await readBook();
  book[userId] = trimmed;
  await writeBook(book);
}

export async function peerDisplayName(userId: string, fallback?: string | null): Promise<string> {
  if (fallback?.trim() && fallback.trim().toLowerCase() !== "peer") {
    return fallback.trim();
  }
  const book = await readBook();
  return book[userId] ?? shortUserId(userId);
}

/** Pull a UUID (and optional leading display name) out of a pasted share blob. */
export function parsePeerShare(raw: string): { userId: string; name: string | null } | null {
  const text = raw.trim();
  if (!text) return null;
  const match = text.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i,
  );
  if (!match) return null;
  const userId = match[0];
  if (!isPeerUserId(userId)) return null;
  const before = text.slice(0, match.index).trim().replace(/[:\-\n]+$/, "").trim();
  const name = before && before.toLowerCase() !== "peer" ? before.slice(0, 64) : null;
  return { userId, name };
}
