import type { BrowserStateConfig } from "../shared/contracts";
import { persistDesktopPreference } from "./desktop-preferences";

export interface BrowserStateStorage {
  read(storageKey: string): Promise<string | null>;
  write(storageKey: string, value: string | null, isStale?: () => boolean): Promise<void>;
  remove?(storageKey: string): Promise<void>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function deriveKey(secret: string, usage: KeyUsage[]): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-CBC" }, false, usage);
}

async function encrypt(value: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(secret, ["encrypt"]);
  const plaintext = encoder.encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-CBC", iv }, key, plaintext);
  return `${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(ciphertext))}`;
}

async function decrypt(value: string, secret: string): Promise<string | null> {
  try {
    const [encodedIv, encodedCiphertext, extra] = value.split(":");
    if (!encodedIv || !encodedCiphertext || extra !== undefined) return null;
    const ivBytes = base64ToBytes(encodedIv);
    if (ivBytes.byteLength !== 16) return null;
    const iv = new Uint8Array(ivBytes).buffer;
    const ciphertextBytes = base64ToBytes(encodedCiphertext);
    const ciphertext = new Uint8Array(ciphertextBytes).buffer;
    const key = await deriveKey(secret, ["decrypt"]);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, key, ciphertext);
    const parsed = JSON.parse(decoder.decode(plaintext));
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export function createBrowserStateStorage(
  config: BrowserStateConfig,
  backend?: Storage,
): BrowserStateStorage {
  const getBackend = (): Storage | null => {
    if (backend) return backend;
    try {
      return typeof localStorage !== "undefined" ? localStorage : null;
    } catch {
      return null;
    }
  };
  return {
    async read(storageKey) {
      let stored: string | null = null;
      try {
        const store = getBackend();
        stored = store ? store.getItem(storageKey) : null;
      } catch {
        return null;
      }
      if (!stored) return null;
      return decrypt(stored, config.secret);
    },
    async write(storageKey, value, isStale) {
      if (value === null) return;
      try {
        const store = getBackend();
        if (!store) return;
        const encrypted = await encrypt(value, config.secret);
        if (isStale?.()) return;
        store.setItem(storageKey, encrypted);
        if (!backend && !storageKey.startsWith("superstring:cache:")) {
          await persistDesktopPreference(storageKey, encrypted);
        }
      } catch {
        // Persistence failure is non-fatal to the action.
      }
    },
    async remove(storageKey) {
      try {
        const store = getBackend();
        store?.removeItem(storageKey);
      } catch {
        // Non-fatal
      }
    },
  };
}

export async function loadBrowserStateStorage(
  loadConfig: () => Promise<BrowserStateConfig>,
): Promise<BrowserStateStorage | null> {
  try {
    return createBrowserStateStorage(await loadConfig());
  } catch {
    return null;
  }
}

export async function loadSessionStateStorage(
  loadConfig: () => Promise<BrowserStateConfig>,
): Promise<BrowserStateStorage | null> {
  try {
    const store = typeof sessionStorage !== "undefined" ? sessionStorage : undefined;
    if (!store) return null;
    return createBrowserStateStorage(await loadConfig(), store);
  } catch {
    return null;
  }
}
