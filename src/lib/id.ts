/**
 * UUID / CSPRNG helpers that work on Hermes (no global `crypto`) and in Node tests.
 * Prefer `globalThis.crypto` when present so unit tests never load expo-crypto.
 */

export function newClientId(): string {
  const web = globalThis.crypto;
  if (web && typeof web.randomUUID === "function") {
    return web.randomUUID();
  }
  // Hermes / older RN — expo-crypto (lazy so Node tests stay free of RN)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ExpoCrypto = require("expo-crypto") as typeof import("expo-crypto");
  return ExpoCrypto.randomUUID();
}

export function fillRandom<T extends Int8Array | Uint8Array | Uint16Array | Uint32Array | Int16Array | Int32Array>(
  values: T,
): T {
  const web = globalThis.crypto;
  if (web && typeof web.getRandomValues === "function") {
    return web.getRandomValues(values);
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ExpoCrypto = require("expo-crypto") as typeof import("expo-crypto");
  return ExpoCrypto.getRandomValues(values);
}
