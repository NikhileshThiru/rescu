"use client";

import { base58Encode, base64ToBytes, bytesToBase64 } from "@rescu/live";

/**
 * The phone's own wallet key ("I live here"): WebCrypto Ed25519, generated NON-extractable and
 * kept in IndexedDB as a CryptoKey. The private key never leaves the browser, not even to us;
 * the server only relays the signed transaction and pays the fee.
 */

const DB = "rescu-aid";
const STORE = "keys";

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = fn(d.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Makes a non-extractable key pair; null when this browser can't do Ed25519 (server custody fallback). */
export async function createDeviceKey(): Promise<{ keys: CryptoKeyPair; pubkey: string } | null> {
  try {
    const keys = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
    if (raw.length !== 32) return null;
    return { keys, pubkey: base58Encode(raw) };
  } catch {
    return null;
  }
}

export async function saveDeviceKey(id: string, keys: CryptoKeyPair): Promise<void> {
  await tx("readwrite", (s) => s.put(keys, id));
}

export async function loadDeviceKey(id: string): Promise<CryptoKeyPair | null> {
  try {
    return ((await tx("readonly", (s) => s.get(id))) as CryptoKeyPair | undefined) ?? null;
  } catch {
    return null;
  }
}

/** Signs a relay request's message with the phone key; base64 signature. */
export async function signMessage(keys: CryptoKeyPair, messageB64: string): Promise<string> {
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", keys.privateKey, base64ToBytes(messageB64) as BufferSource));
  return bytesToBase64(sig);
}

export const keyId = (runId: string, resident: number) => `${runId}:${resident}`;
