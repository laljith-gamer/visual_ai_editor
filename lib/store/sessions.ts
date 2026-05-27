import type { Session } from "@/lib/types";
import { idbSessions } from "./idb";

const INDEX_KEY = "__index__";

interface SessionIndex {
  ids: string[];
}

async function readIndex(): Promise<SessionIndex> {
  return (await idbSessions.get<SessionIndex>(INDEX_KEY)) ?? { ids: [] };
}

async function writeIndex(idx: SessionIndex) {
  await idbSessions.set(INDEX_KEY, idx);
}

export async function listSessions(): Promise<Session[]> {
  const idx = await readIndex();
  const all = await Promise.all(
    idx.ids.map((id) => idbSessions.get<Session>(id))
  );
  return all
    .filter((s): s is Session => Boolean(s))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function loadSession(id: string): Promise<Session | undefined> {
  return idbSessions.get<Session>(id);
}

export async function saveSession(session: Session): Promise<void> {
  await idbSessions.set(session.id, session);
  const idx = await readIndex();
  if (!idx.ids.includes(session.id)) {
    idx.ids.unshift(session.id);
    await writeIndex(idx);
  }
}

export async function deleteSession(id: string): Promise<void> {
  await idbSessions.del(id);
  const idx = await readIndex();
  idx.ids = idx.ids.filter((i) => i !== id);
  await writeIndex(idx);
}
