// FORK: Standalone (local) SSH mode.
// When enabled, SSH connections originate from THIS device through the
// embedded Node.js engine (see localTerminal.ts) and host records live in
// AsyncStorage instead of a remote server. The remote server link keeps
// working for data sync; it is never used to originate connections.
import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY_ENABLED = "termix.localMode.enabled";
const KEY_HOSTS = "termix.localHosts.v1";

export interface LocalHost {
  id: number;
  name: string;
  ip: string;
  port: number;
  username: string;
  authType: "password" | "key" | "none";
  password?: string | null;
  key?: string | null;
  keyPassword?: string | null;
  keyType?: string | null;
  folder?: string;
  tags?: string[];
  pin?: boolean;
  defaultPath?: string;
  createdAt?: string;
  updatedAt?: string;
}

let cacheEnabled: boolean | null = null;

/** True when standalone mode is on. Cached after the first read; mutate via
 *  setLocalModeEnabled so the in-memory state never lags the store.
 *
 *  FORK: standalone (local SSH) is the DEFAULT mode — connections always
 *  originate from this device. A never-touched device starts with it on;
 *  the Settings toggle can still turn it off for legacy server relay. */
export async function isLocalModeEnabled(): Promise<boolean> {
  if (cacheEnabled !== null) return cacheEnabled;
  try {
    const raw = await AsyncStorage.getItem(KEY_ENABLED);
    cacheEnabled = raw === null ? true : raw === "1";
  } catch (_) {
    cacheEnabled = true;
  }
  return cacheEnabled;
}

export async function setLocalModeEnabled(enabled: boolean): Promise<void> {
  cacheEnabled = enabled;
  try {
    await AsyncStorage.setItem(KEY_ENABLED, enabled ? "1" : "0");
  } catch (_) {
    /* storage failure is non-fatal for a toggle */
  }
}

export async function getLocalHosts(): Promise<LocalHost[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY_HOSTS);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

export async function saveLocalHosts(hosts: LocalHost[]): Promise<void> {
  await AsyncStorage.setItem(KEY_HOSTS, JSON.stringify(hosts));
}

/** Insert or update; assigns a fresh id when missing. Returns the host. */
export async function upsertLocalHost(
  host: Omit<LocalHost, "id"> & { id?: number },
): Promise<LocalHost> {
  const hosts = await getLocalHosts();
  const now = new Date().toISOString();
  if (host.id != null) {
    const idx = hosts.findIndex((h) => h.id === host.id);
    if (idx >= 0) {
      const updated: LocalHost = {
        ...hosts[idx],
        ...host,
        id: host.id,
        updatedAt: now,
      };
      hosts[idx] = updated;
      await saveLocalHosts(hosts);
      return updated;
    }
  }
  const nextId = hosts.reduce((m, h) => Math.max(m, h.id || 0), 0) + 1;
  const created: LocalHost = {
    ...host,
    id: host.id ?? nextId,
    createdAt: now,
    updatedAt: now,
  };
  hosts.push(created);
  await saveLocalHosts(hosts);
  return created;
}

export async function deleteLocalHost(id: number): Promise<void> {
  const hosts = await getLocalHosts();
  await saveLocalHosts(hosts.filter((h) => h.id !== id));
}

export async function getLocalHostById(
  id: number,
): Promise<LocalHost | null> {
  const hosts = await getLocalHosts();
  return hosts.find((h) => h.id === id) ?? null;
}
