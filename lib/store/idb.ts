import { get, set, del, keys, createStore } from "idb-keyval";

const sessionStore = createStore("shorts-studio-sessions", "kv");
const cacheStore = createStore("shorts-studio-cache", "kv");

export const idbSessions = {
  get: <T>(key: string) => get<T>(key, sessionStore),
  set: <T>(key: string, value: T) => set(key, value, sessionStore),
  del: (key: string) => del(key, sessionStore),
  keys: () => keys(sessionStore)
};

export const idbCache = {
  get: <T>(key: string) => get<T>(key, cacheStore),
  set: <T>(key: string, value: T) => set(key, value, cacheStore),
  del: (key: string) => del(key, cacheStore),
  keys: () => keys(cacheStore)
};
