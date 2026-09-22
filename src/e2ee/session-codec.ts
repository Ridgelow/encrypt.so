import { SessionRecordError } from "./errors";

/**
 * JSON codec for SDK `SessionRecord` values.
 *
 * `@open-e2ee/signal-protocol-sdk` keeps the same replacer inside its store
 * adapters (`serializeSessionRecord`). That helper is not a package export, so
 * the replacer is repeated here. It does not implement the ratchet.
 */
const SESSION_JSON_TYPE_TAG = "__signalProtocolJsonType";

export function serializeSessionRecord(record: unknown): string {
  return JSON.stringify(record, (_key, value: unknown) => {
    if (typeof value === "bigint") {
      return { [SESSION_JSON_TYPE_TAG]: "bigint", value: value.toString() };
    }
    if (value instanceof Uint8Array) {
      return { [SESSION_JSON_TYPE_TAG]: "uint8array", value: Array.from(value) };
    }
    if (value instanceof Map) {
      return { [SESSION_JSON_TYPE_TAG]: "map", entries: Array.from(value.entries()) as unknown[] };
    }
    return value;
  });
}

export function deserializeSessionRecord(json: string): unknown {
  try {
    return JSON.parse(json, (_key, value: unknown) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      const tagged = value as Record<string, unknown>;
      if (tagged[SESSION_JSON_TYPE_TAG] === "bigint") {
        if (typeof tagged.value !== "string" || !/^-?\d+$/.test(tagged.value)) {
          throw new SessionRecordError();
        }
        return BigInt(tagged.value);
      }
      if (tagged[SESSION_JSON_TYPE_TAG] === "uint8array") {
        if (!Array.isArray(tagged.value)) throw new SessionRecordError();
        return Uint8Array.from(tagged.value as number[]);
      }
      if (tagged[SESSION_JSON_TYPE_TAG] === "map") {
        const entries = tagged.entries;
        if (
          !Array.isArray(entries) ||
          !entries.every((entry) => Array.isArray(entry) && entry.length === 2)
        ) {
          throw new SessionRecordError();
        }
        return new Map(entries as Array<[unknown, unknown]>);
      }
      return value;
    });
  } catch (error) {
    if (error instanceof SessionRecordError) throw error;
    throw new SessionRecordError();
  }
}
