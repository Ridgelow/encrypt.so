import {
  acceptSenderKeyDistribution,
  commitGroupSenderKey,
  decryptFromGroup,
  encryptForGroup,
  ensureSessionWithUser,
  LOCAL_PROTOCOL_DEVICE_ID,
  prepareGroupSenderKey,
  SENDER_KEY_CONTENT_TYPE,
  SENDER_KEY_DIST_CONTENT_TYPE,
  senderKeyDistributionCiphertext,
  decodeGroupDistribution,
  decodeGroupSender,
} from "@/e2ee";
import type { CiphertextMessage, Conversation, MessagingClient, PostMessageInput } from "@/services/api";
import { isExpired } from "@/services/disappear";
import { openSecureMessageCache, type CachedMessage, type MessageCache } from "@/services/messageCache";
import {
  connectRealtime,
  isDeviceUuid,
  type RealtimeTransportFactory,
  type ServerFrame,
} from "@/services/realtime";
import type { LiveThreadMessage } from "@/services/liveChat";

export type GroupPublishOptions = {
  expireAt?: number | null;
  createdAt?: number;
};

export type GroupChat = {
  conversationId: string;
  title: string;
  memberUserIds: string[];
  history: LiveThreadMessage[];
  publish(plaintext: string, options?: GroupPublishOptions): Promise<{ id: string }>;
  close(): void;
};

const HISTORY_PAGE = 50;
const HISTORY_PAGES = 5;

async function loadPages(
  messaging: Pick<MessagingClient, "listMessages">,
  token: string,
  conversationId: string,
): Promise<CiphertextMessage[]> {
  const rows: CiphertextMessage[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < HISTORY_PAGES; page += 1) {
    const result = await messaging.listMessages(token, conversationId, { cursor, limit: HISTORY_PAGE });
    rows.push(...result.messages);
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return rows;
}

function senderDeviceIdOf(value: string): string | undefined {
  return isDeviceUuid(value) ? value : undefined;
}

async function postCiphertext(input: {
  messaging: Pick<MessagingClient, "postMessage">;
  token: string;
  conversationId: string;
  ciphertext: string;
  contentType: string;
  clientId: string;
  senderDeviceId?: string;
  expireAt?: number;
}): Promise<void> {
  const body: PostMessageInput = {
    ciphertext: input.ciphertext,
    contentType: input.contentType,
    clientId: input.clientId,
  };
  if (input.senderDeviceId) body.senderDeviceId = input.senderDeviceId;
  if (typeof input.expireAt === "number") body.expireAt = input.expireAt;
  await input.messaging.postMessage(input.token, input.conversationId, body);
}

/**
 * Deliver any pending sender-key distributions, then one shared group ciphertext.
 * Distributions travel as pairwise envelopes inside the group conversation.
 */
export async function distributeSenderKey(input: {
  token: string;
  groupId: string;
  memberUserIds: readonly string[];
  localUserId: string;
  messaging: Pick<MessagingClient, "postMessage">;
  send?: (ciphertext: string, contentType: string, clientId: string, senderDeviceId?: string) => Promise<void>;
}): Promise<void> {
  for (const memberId of input.memberUserIds) {
    if (memberId === input.localUserId) continue;
    await ensureSessionWithUser(memberId);
  }
  const prepared = await prepareGroupSenderKey(input.groupId, input.memberUserIds);
  let senderDeviceId: string | undefined;
  for (const envelope of prepared.envelopes) {
    const clientId = crypto.randomUUID();
    const ciphertext = senderKeyDistributionCiphertext(input.groupId, LOCAL_PROTOCOL_DEVICE_ID, envelope);
    senderDeviceId = senderDeviceIdOf(envelope.senderDeviceId);
    if (input.send) await input.send(ciphertext, SENDER_KEY_DIST_CONTENT_TYPE, clientId, senderDeviceId);
    await postCiphertext({
      messaging: input.messaging,
      token: input.token,
      conversationId: input.groupId,
      ciphertext,
      contentType: SENDER_KEY_DIST_CONTENT_TYPE,
      clientId,
      senderDeviceId,
    });
  }
  if (prepared.envelopes.length > 0) {
    await commitGroupSenderKey(input.groupId, prepared.senderKeyId, input.memberUserIds);
  }
}

async function takeDistribution(ciphertext: string, localUserId: string): Promise<void> {
  let wire;
  try {
    wire = decodeGroupDistribution(ciphertext);
  } catch {
    return;
  }
  if (wire.envelope.recipientUserId !== localUserId) return;
  if (wire.envelope.senderUserId === localUserId) return;
  try {
    await acceptSenderKeyDistribution(wire.groupId, wire.protocolDeviceId, wire.envelope);
  } catch {
    // A repeat distribution is already stored.
  }
}

/**
 * Live group thread. The conversation already exists.
 * History is applied oldest-first so a sender-key distribution lands before the messages it opens.
 */
export async function openGroupChat(options: {
  httpBase: string;
  sessionToken: string;
  localUserId: string;
  groupId: string;
  messaging: Pick<MessagingClient, "getConversation" | "postMessage" | "listMessages">;
  cache?: MessageCache | null;
  factory?: RealtimeTransportFactory;
  onMessage: (message: LiveThreadMessage) => void;
}): Promise<GroupChat> {
  const conversation = await options.messaging.getConversation(options.sessionToken, options.groupId);
  const cache = options.cache === undefined ? await openSecureMessageCache().catch(() => null) : options.cache;
  const memberUserIds = conversation.members.map((member) => member.userId);

  let tail: Promise<void> = Promise.resolve();

  async function remember(message: LiveThreadMessage, senderDeviceId?: string): Promise<void> {
    if (!cache) return;
    const entry: CachedMessage = {
      id: message.id,
      conversationId: conversation.id,
      plaintext: message.text,
      createdAt: message.createdAt,
      senderDeviceId,
      from: message.from,
      ...(typeof message.expireAt === "number" ? { expireAt: message.expireAt } : {}),
      ...(message.contentType ? { contentType: message.contentType } : {}),
    };
    try {
      await cache.save(entry);
    } catch {
      // The thread still updates if Secure Store refuses the write.
    }
  }

  async function incoming(frame: Extract<ServerFrame, { type: "message" }>): Promise<void> {
    if (isExpired(frame.expireAt)) return;
    if (frame.contentType === SENDER_KEY_DIST_CONTENT_TYPE) {
      await takeDistribution(frame.ciphertext, options.localUserId);
      return;
    }
    if (frame.contentType !== SENDER_KEY_CONTENT_TYPE) return;
    let payload;
    try {
      payload = decodeGroupSender(frame.ciphertext);
    } catch {
      return;
    }
    if (payload.senderUserId === options.localUserId) return;
    let text = "Message unavailable";
    try {
      text = await decryptFromGroup(frame.ciphertext);
    } catch {
      text = "Message unavailable";
    }
    const message: LiveThreadMessage = {
      id: frame.clientId ?? frame.id ?? `live-${frame.createdAt}`,
      from: "them",
      text,
      createdAt: frame.createdAt || Date.now(),
      expireAt: frame.expireAt,
      contentType: SENDER_KEY_CONTENT_TYPE,
      senderUserId: payload.senderUserId,
    };
    options.onMessage(message);
    if (text !== "Message unavailable") await remember(message, frame.senderDeviceId ?? undefined);
  }

  if (cache) {
    try {
      await cache.purgeExpired();
    } catch {
      // History still loads when the cache cannot drop expired rows.
    }
  }
  const cached = cache ? await cache.list(conversation.id).catch(() => []) : [];
  const cachedById = new Map(cached.map((message) => [message.id, message]));
  let rows: CiphertextMessage[] = [];
  try {
    rows = await loadPages(options.messaging, options.sessionToken, conversation.id);
  } catch {
    rows = [];
  }

  const history: LiveThreadMessage[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (isExpired(row.expireAt)) continue;
    if (row.contentType === SENDER_KEY_DIST_CONTENT_TYPE) {
      await takeDistribution(row.ciphertext, options.localUserId);
      continue;
    }
    if (row.contentType !== SENDER_KEY_CONTENT_TYPE) continue;
    let payload;
    try {
      payload = decodeGroupSender(row.ciphertext);
    } catch {
      continue;
    }
    const id = row.clientId ?? row.id;
    if (seen.has(id)) continue;
    seen.add(id);
    const saved = cachedById.get(id) ?? cachedById.get(row.id);
    const expireAt = row.expireAt ?? saved?.expireAt ?? null;
    if (payload.senderUserId === options.localUserId || saved?.from === "me") {
      if (!saved) continue;
      history.push({
        id,
        from: "me",
        text: saved.plaintext,
        createdAt: saved.createdAt,
        expireAt,
        contentType: SENDER_KEY_CONTENT_TYPE,
      });
      continue;
    }
    let text = saved?.plaintext;
    if (text == null) {
      try {
        text = await decryptFromGroup(row.ciphertext);
      } catch {
        text = "Message unavailable";
      }
      if (text !== "Message unavailable") {
        await remember(
          {
            id,
            from: "them",
            text,
            createdAt: row.createdAt,
            expireAt,
            contentType: SENDER_KEY_CONTENT_TYPE,
            senderUserId: payload.senderUserId,
          },
          row.senderDeviceId,
        );
      }
    }
    history.push({
      id,
      from: "them",
      text,
      createdAt: row.createdAt,
      expireAt,
      contentType: SENDER_KEY_CONTENT_TYPE,
      senderUserId: payload.senderUserId,
    });
  }
  history.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));

  const connection = connectRealtime({
    httpBase: options.httpBase,
    token: options.sessionToken,
    conversationId: conversation.id,
    factory: options.factory,
    onFrame(frame) {
      if (frame.type !== "message") return;
      const run = tail.then(() => incoming(frame), () => incoming(frame));
      tail = run.then(
        () => undefined,
        () => undefined,
      );
    },
  });

  return {
    conversationId: conversation.id,
    title: conversation.title ?? "Group",
    memberUserIds,
    history,
    async publish(plaintext, publishOptions) {
      const clientId = crypto.randomUUID();
      const expireAt = typeof publishOptions?.expireAt === "number" ? publishOptions.expireAt : undefined;
      const createdAt = publishOptions?.createdAt ?? Date.now();
      let members = memberUserIds;
      try {
        const latest = await options.messaging.getConversation(options.sessionToken, conversation.id);
        members = latest.members.map((member) => member.userId);
      } catch {
        // Keep the member list from when the thread opened.
      }
      await distributeSenderKey({
        token: options.sessionToken,
        groupId: conversation.id,
        memberUserIds: members,
        localUserId: options.localUserId,
        messaging: options.messaging,
        send: async (ciphertext, contentType, distributionId, senderDeviceId) => {
          try {
            await connection.sendEnvelope({
              conversationId: conversation.id,
              ciphertext,
              contentType,
              clientId: distributionId,
              senderDeviceId,
            });
          } catch (err) {
            console.warn("[realtime] distribution fan-out skipped", err instanceof Error ? err.message : "");
          }
        },
      });
      const sealed = await encryptForGroup(conversation.id, plaintext);
      const senderDeviceId = senderDeviceIdOf(sealed.senderDeviceId);
      try {
        await connection.sendEnvelope({
          conversationId: conversation.id,
          ciphertext: sealed.ciphertext,
          contentType: SENDER_KEY_CONTENT_TYPE,
          clientId,
          senderDeviceId,
          ...(expireAt != null ? { expireAt } : {}),
        });
      } catch (err) {
        console.warn("[realtime] fan-out skipped", err instanceof Error ? err.message : "");
      }
      try {
        await postCiphertext({
          messaging: options.messaging,
          token: options.sessionToken,
          conversationId: conversation.id,
          ciphertext: sealed.ciphertext,
          contentType: SENDER_KEY_CONTENT_TYPE,
          clientId,
          senderDeviceId,
          expireAt,
        });
      } catch (err) {
        console.warn("[realtime] persist skipped", err instanceof Error ? err.message : "");
      }
      await remember(
        {
          id: clientId,
          from: "me",
          text: plaintext,
          createdAt,
          expireAt: expireAt ?? null,
          contentType: SENDER_KEY_CONTENT_TYPE,
        },
        senderDeviceId,
      );
      return { id: clientId };
    },
    close() {
      connection.close();
    },
  };
}

/** Create the group row and hand each member a sender key before the thread opens. */
export async function createLiveGroup(input: {
  origin: string;
  sessionToken: string;
  localUserId: string;
  title: string;
  memberUserIds: string[];
  messaging: Pick<MessagingClient, "createGroup" | "postMessage">;
}): Promise<Conversation> {
  const conversation = await input.messaging.createGroup(input.sessionToken, {
    title: input.title,
    memberUserIds: input.memberUserIds,
  });
  await distributeSenderKey({
    token: input.sessionToken,
    groupId: conversation.id,
    memberUserIds: conversation.members.map((member) => member.userId),
    localUserId: input.localUserId,
    messaging: input.messaging,
  });
  return conversation;
}

/**
 * Add one member, then rotate this device's sender key and distribute it again.
 * v1 has no remove-member route. Removal would also rotate, but it is not implemented.
 */
export async function addLiveGroupMember(input: {
  token: string;
  groupId: string;
  localUserId: string;
  userId: string;
  messaging: Pick<MessagingClient, "addMember" | "postMessage">;
}): Promise<Conversation> {
  const conversation = await input.messaging.addMember(input.token, input.groupId, input.userId);
  await distributeSenderKey({
    token: input.token,
    groupId: input.groupId,
    memberUserIds: conversation.members.map((member) => member.userId),
    localUserId: input.localUserId,
    messaging: input.messaging,
  });
  return conversation;
}

/** True for a group conversation id when the API and a session are present. Mock groups stay local. */
export function liveGroupEnabled(input: {
  groupId: string | null;
  apiConfigured: boolean;
  hasSession: boolean;
}): boolean {
  return Boolean(input.groupId) && input.apiConfigured && input.hasSession;
}
