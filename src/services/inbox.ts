import * as SecureStore from "expo-secure-store";
import { isPeerUserId } from "@/e2ee";
import { peerDisplayName, shortUserId } from "@/services/contacts";
import type { ChatPreview } from "@/data/mock";

const INBOX_KEY = "encrypt.inbox.v1";

export type InboxThread = {
  /** Conversation id from the worker when known; otherwise the peer user id. */
  id: string;
  peerUserId: string;
  preview: string;
  updatedAt: number;
  group?: boolean;
  title?: string;
};

async function readInbox(): Promise<InboxThread[]> {
  const raw = await SecureStore.getItemAsync(INBOX_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: InboxThread[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      if (typeof row.peerUserId !== "string" || !isPeerUserId(row.peerUserId)) continue;
      if (typeof row.id !== "string" || !row.id) continue;
      out.push({
        id: row.id,
        peerUserId: row.peerUserId,
        preview: typeof row.preview === "string" ? row.preview.slice(0, 160) : "End-to-end encrypted",
        updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : Date.now(),
        group: row.group === true,
        title: typeof row.title === "string" ? row.title : undefined,
      });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

async function writeInbox(threads: InboxThread[]): Promise<void> {
  const trimmed = threads.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 100);
  await SecureStore.setItemAsync(INBOX_KEY, JSON.stringify(trimmed));
}

/** Known conversation id for a peer, if we've opened/sent before. */
export async function inboxConversationId(peerUserId: string): Promise<string | null> {
  if (!isPeerUserId(peerUserId)) return null;
  const threads = await readInbox();
  const hit = threads.find((thread) => !thread.group && thread.peerUserId === peerUserId);
  if (!hit) return null;
  return hit.id !== peerUserId ? hit.id : null;
}

/** Upsert a 1:1 thread so Messages shows it immediately after open/send. */
export async function touchInboxThread(input: {
  peerUserId: string;
  conversationId?: string | null;
  preview?: string;
  name?: string | null;
}): Promise<void> {
  if (!isPeerUserId(input.peerUserId)) return;
  const threads = await readInbox();
  // Prefer server conversation id when we have one (any non-empty id).
  const id = (input.conversationId?.trim() || input.peerUserId) as string;
  const next: InboxThread = {
    id,
    peerUserId: input.peerUserId,
    preview: (input.preview ?? "End-to-end encrypted").slice(0, 160),
    updatedAt: Date.now(),
  };
  const without = threads.filter(
    (thread) => !thread.group && thread.peerUserId !== input.peerUserId,
  );
  without.push(next);
  await writeInbox(without);
}

export async function touchGroupThread(input: {
  groupId: string;
  title?: string | null;
  preview?: string;
}): Promise<void> {
  if (!isPeerUserId(input.groupId)) return;
  const threads = await readInbox();
  const next: InboxThread = {
    id: input.groupId,
    peerUserId: input.groupId,
    preview: (input.preview ?? "Encrypted group").slice(0, 160),
    updatedAt: Date.now(),
    group: true,
    title: input.title?.trim() || "Group",
  };
  const without = threads.filter((thread) => thread.id !== input.groupId);
  without.push(next);
  await writeInbox(without);
}

function initialsFor(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ""}${parts[1]![0] ?? ""}`.toUpperCase();
}

function clock(at: number): string {
  const now = new Date(at);
  return `${now.getHours()}:${String(now.getMinutes()).padStart(2, "0")}`;
}

async function toPreview(thread: InboxThread): Promise<ChatPreview> {
  if (thread.group) {
    const name = thread.title?.trim() || "Group";
    return {
      id: thread.id,
      name,
      initials: initialsFor(name),
      preview: thread.preview,
      time: clock(thread.updatedAt),
      locked: true,
      group: true,
      userId: thread.id,
    };
  }
  const name = await peerDisplayName(thread.peerUserId);
  return {
    id: thread.id,
    name,
    initials: initialsFor(name),
    preview: thread.preview,
    time: clock(thread.updatedAt),
    locked: true,
    userId: thread.peerUserId,
  };
}

/**
 * Merge server conversations with the on-device inbox so a brand-new chat
 * appears as soon as you leave the thread, even if listConversations lags.
 */
export async function loadInboxPreviews(input: {
  localUserId: string;
  remote: Array<{
    id: string;
    kind: "direct" | "group";
    title: string | null;
    members: Array<{ userId: string }>;
  }>;
}): Promise<ChatPreview[]> {
  const local = await readInbox();
  const byKey = new Map<string, InboxThread>();

  for (const thread of local) {
    byKey.set(thread.group ? `g:${thread.id}` : `d:${thread.peerUserId}`, thread);
  }

  for (const conversation of input.remote) {
    if (conversation.kind === "group") {
      const existing = byKey.get(`g:${conversation.id}`);
      byKey.set(`g:${conversation.id}`, {
        id: conversation.id,
        peerUserId: conversation.id,
        preview: existing?.preview ?? "Encrypted group",
        updatedAt: existing?.updatedAt ?? Date.now(),
        group: true,
        title: conversation.title?.trim() || existing?.title || "Group",
      });
      continue;
    }
    const peer = conversation.members.find((member) => member.userId !== input.localUserId);
    if (!peer || !isPeerUserId(peer.userId)) continue;
    const existing = byKey.get(`d:${peer.userId}`);
    byKey.set(`d:${peer.userId}`, {
      id: conversation.id,
      peerUserId: peer.userId,
      preview: existing?.preview ?? "End-to-end encrypted",
      updatedAt: existing?.updatedAt ?? Date.now(),
    });
  }

  const merged = [...byKey.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  await writeInbox(merged);
  return Promise.all(merged.map(toPreview));
}

export async function loadLocalInboxPreviews(): Promise<ChatPreview[]> {
  const local = await readInbox();
  return Promise.all(local.map(toPreview));
}

export { shortUserId };
