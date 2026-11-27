const DELETED_PREFIX = "huellicam_deleted_chats_";
const CHAT_MSG_CACHE_PREFIX = "huellicam_chat_";

function getDeletedKey(userId?: string): string {
  return `${DELETED_PREFIX}${userId || "anon"}`;
}

export function readDeletedChatIds(userId?: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(getDeletedKey(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function saveDeletedChatIds(userId: string | undefined, ids: string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(getDeletedKey(userId), JSON.stringify(Array.from(new Set(ids))));
  } catch {
    // Ignore storage quota or private mode restrictions
  }
}

export function addDeletedChatId(ids: string[], chatId: string): string[] {
  return ids.includes(chatId) ? ids : [...ids, chatId];
}

export function clearChatLocalCache(chatId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(`${CHAT_MSG_CACHE_PREFIX}${chatId}`);
  } catch {
    // Ignore storage restrictions
  }
}
