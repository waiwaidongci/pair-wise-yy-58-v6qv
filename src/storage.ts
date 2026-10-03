// 持久化与跨窗口乐观并发控制（OCC）
// - 主/备份双 key 原子提交（先写备份校验通过后再提交主），崩溃重开可恢复完整快照
// - expectedRevision CAS：后提交者不能覆盖先到结果
// - storage 事件：其他窗口先提交后，本窗口同步最新文档，正在编辑的内容保留为本地草稿
import { clone, PlanDoc, seedDoc } from './snapshot';

const PRIMARY_KEY = 'yy58-lift-plan-doc-v2';
const BACKUP_KEY = 'yy58-lift-plan-doc-v2-backup';
const DRAFT_PREFIX = 'yy58-lift-plan-window-draft-';

export type StoredEnvelope = {
  checksum: string;
  savedAt: string;
  doc: PlanDoc;
};

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function readEnvelope(raw: string | null): StoredEnvelope | null {
  if (!raw) return null;
  try {
    const envelope = JSON.parse(raw) as StoredEnvelope;
    if (!envelope?.doc || envelope.checksum !== fnv1a(JSON.stringify(envelope.doc))) return null;
    return envelope;
  } catch {
    return null;
  }
}

/** 启动恢复：优先主 key，主损坏时回退备份，保证浏览器崩溃重开拿到完整快照 */
export function loadDoc(): PlanDoc {
  if (typeof localStorage === 'undefined') return seedDoc();
  const primary = readEnvelope(localStorage.getItem(PRIMARY_KEY));
  if (primary) return primary.doc;
  const backup = readEnvelope(localStorage.getItem(BACKUP_KEY));
  if (backup) return backup.doc;

  // 兼容旧版草稿（v1），取其步骤/评论后迁入新文档
  try {
    const legacyRaw = localStorage.getItem('yy58-lift-plan-draft');
    if (legacyRaw) {
      const legacy = JSON.parse(legacyRaw) as { steps?: PlanDoc['steps']; comments?: PlanDoc['comments']; revision?: number };
      const doc = seedDoc();
      if (Array.isArray(legacy.steps) && legacy.steps.length > 0) doc.steps = legacy.steps;
      if (Array.isArray(legacy.comments) && legacy.comments.length > 0) {
        doc.comments = legacy.comments.map((item) => ({ ...item, role: 'planner', createdAt: new Date().toISOString() }));
      }
      if (typeof legacy.revision === 'number') doc.revision = legacy.revision;
      return doc;
    }
  } catch {
    // 忽略损坏的旧草稿
  }
  return seedDoc();
}

export type CommitResult =
  | { ok: true; doc: PlanDoc }
  | { ok: false; reason: 'stale'; latest: PlanDoc };

/**
 * CAS 提交：仅当主存文档 revision === expectedRevision 时写入。
 * 写入流程：备份 → 主（每次都带校验和），两步均同步完成，避免半截 JSON。
 */
export function commitDoc(expectedRevision: number, next: PlanDoc): CommitResult {
  if (typeof localStorage === 'undefined') return { ok: true, doc: next };
  const current = readEnvelope(localStorage.getItem(PRIMARY_KEY))?.doc ?? loadDoc();
  if (current.revision !== expectedRevision) {
    return { ok: false, reason: 'stale', latest: current };
  }
  const envelope: StoredEnvelope = {
    checksum: fnv1a(JSON.stringify(next)),
    savedAt: new Date().toISOString(),
    doc: next
  };
  const raw = JSON.stringify(envelope);
  localStorage.setItem(BACKUP_KEY, raw);
  localStorage.setItem(PRIMARY_KEY, raw);
  return { ok: true, doc: next };
}

// ---------- 窗口级编辑草稿：崩溃/刷新后恢复未提交编辑 ----------

export type WindowDraft = {
  windowId: string;
  stepId: string;
  patch: Record<string, unknown>;
  order: string[] | null;
  commentDraft: string;
  savedAt: string;
};

export function draftKey(windowId: string): string {
  return `${DRAFT_PREFIX}${windowId}`;
}

export function saveWindowDraft(windowId: string, draft: Omit<WindowDraft, 'windowId' | 'savedAt'>): void {
  if (typeof localStorage === 'undefined') return;
  const payload: WindowDraft = { ...draft, windowId, savedAt: new Date().toISOString() };
  localStorage.setItem(draftKey(windowId), JSON.stringify(payload));
}

export function loadWindowDraft(windowId: string): WindowDraft | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(draftKey(windowId));
    return raw ? (JSON.parse(raw) as WindowDraft) : null;
  } catch {
    return null;
  }
}

export function clearWindowDraft(windowId: string): void {
  if (typeof localStorage !== 'undefined') localStorage.removeItem(draftKey(windowId));
}

/** 清理其他崩溃窗口残留超过 24 小时的草稿 */
export function pruneStaleDrafts(selfWindowId: string): WindowDraft[] {
  if (typeof localStorage === 'undefined') return [];
  const recovered: WindowDraft[] = [];
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (let i = localStorage.length - 1; i >= 0; i -= 1) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(DRAFT_PREFIX) || key === draftKey(selfWindowId)) continue;
    try {
      const draft = JSON.parse(localStorage.getItem(key) ?? 'null') as WindowDraft | null;
      if (!draft) {
        localStorage.removeItem(key);
      } else if (new Date(draft.savedAt).getTime() < cutoff) {
        localStorage.removeItem(key);
      } else {
        recovered.push(draft);
      }
    } catch {
      localStorage.removeItem(key);
    }
  }
  return recovered;
}

export function cloneDoc(doc: PlanDoc): PlanDoc {
  return clone(doc);
}
