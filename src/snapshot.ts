// 参数快照核心：步骤顺序、角色职责域、内容哈希、规则校验
// 同一份 PlanDoc（steps+comments+signatures）的内容哈希构成"参数快照"，
// 签署、发布版本均绑定到这份快照。

export type StepStatus = 'pending' | 'passed' | 'blocked';

export type LiftStep = {
  id: string;
  title: string;
  time: string;
  loadRate: number;
  clearance: number;
  wind: number;
  radius: number;
  boom: number;
  groundBearing: number;
  siteHandover: boolean;
  status: StepStatus;
  note: string;
};

export type Comment = {
  id: string;
  author: string;
  role: RoleId;
  content: string;
  status: 'open' | 'resolved';
  stepId: string;
  createdAt: string;
};

export type RoleId = 'general' | 'equipment' | 'safety' | 'planner';

export type RoleDef = {
  id: RoleId;
  name: string;
  team: string;
  scopeLabel: string;
  // 该角色会签覆盖的步骤字段
  fields: StepField[];
};

export type StepField =
  | 'time'
  | 'loadRate'
  | 'clearance'
  | 'wind'
  | 'radius'
  | 'boom'
  | 'groundBearing'
  | 'siteHandover'
  | 'status'
  | 'note';

export const ROLES: RoleDef[] = [
  {
    id: 'general',
    name: '陈晓',
    team: '总包项目部',
    scopeLabel: '吊装工序与场地移交',
    fields: ['time', 'siteHandover', 'status', 'note']
  },
  {
    id: 'equipment',
    name: '刘明',
    team: '设备管理',
    scopeLabel: '吊车参数与支腿地基',
    fields: ['radius', 'boom', 'groundBearing']
  },
  {
    id: 'safety',
    name: '周工',
    team: '安全监督',
    scopeLabel: '净空、风速与警戒区',
    fields: ['clearance', 'wind']
  },
  {
    id: 'planner',
    name: '赵磊',
    team: '方案工程',
    scopeLabel: '载荷计算与路径参数',
    fields: ['loadRate']
  }
];

export const ROLE_MAP: Record<RoleId, RoleDef> = ROLES.reduce((acc, role) => {
  acc[role.id] = role;
  return acc;
}, {} as Record<RoleId, RoleDef>);

export const FIELD_LABELS: Record<StepField, string> = {
  time: '作业时间',
  loadRate: '荷载率',
  clearance: '最小净空',
  wind: '风速限制',
  radius: '作业半径',
  boom: '臂长',
  groundBearing: '地耐力',
  siteHandover: '场地移交',
  status: '步骤结论',
  note: '现场控制说明'
};

/**
 * 步骤顺序是全体会签共享项：顺序变化对四个角色同时失效。
 * 各角色职责内的数值/文本变化，只作废该角色自己的签署。
 */
export const ORDER_SCOPE = '__order__' as const;

export type Signature = {
  role: RoleId;
  signer: string;
  revision: number; // 签署时文档 revision（CAS 令牌）
  snapshotId: string; // 签署时全量参数快照
  scopeHash: string; // 签署时本角色职责域哈希
  orderHash: string; // 签署时步骤顺序哈希
  scopeValues: Record<string, Partial<LiftStep>>; // 签署时职责内各步骤数值
  orderIds: string[]; // 签署时步骤顺序
  signedAt: string;
};

export type RuleConflict = {
  id: string;
  stepId: string;
  title: string;
  message: string;
  severity: 'high' | 'medium';
};

/** 并发提交失败后留存复核的冲突记录 */
export type PendingConflict = {
  id: string;
  kind: 'edit' | 'reorder' | 'sign' | 'comment' | 'resolve';
  role: RoleId;
  author: string;
  summary: string;
  detail: string;
  baseRevision: number; // 后提交者依据的版本
  landedRevision: number; // 先到结果的版本
  stepsPatch?: { [stepId: string]: Partial<LiftStep> };
  orderedStepIds?: string[];
  comment?: { stepId: string; content: string };
  resolveCommentId?: string;
  createdAt: string;
  status: 'pending' | 'reapplied' | 'abandoned';
};

export type PublishedVersion = {
  revision: number;
  snapshotId: string;
  publishedAt: string;
  publisher: string;
  steps: LiftStep[];
  comments: Comment[];
  signatures: Signature[];
};

export type PlanDoc = {
  format: 2;
  planId: string;
  name: string;
  revision: number;
  steps: LiftStep[];
  comments: Comment[];
  signatures: Signature[];
  conflicts: PendingConflict[];
  versions: PublishedVersion[];
  updatedAt: string;
};

// ---------- 内容哈希（FNV-1a 32bit，稳定序列化） ----------

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(',')}}`;
}

export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function snapshotOf(steps: LiftStep[]): string {
  const ordered = steps.map((step, index) => ({ index, step: { ...step } }));
  return `SNAP-${fnv1a(stableStringify(ordered)).slice(0, 10)}`;
}

export function orderHashOf(steps: LiftStep[]): string {
  return fnv1a(steps.map((step) => step.id).join('|'));
}

export function scopeHashOf(role: RoleId, steps: LiftStep[]): string {
  const fields = ROLE_MAP[role].fields;
  const scoped = steps.map((step) => {
    const picked: Record<string, unknown> = { id: step.id };
    fields.forEach((field) => {
      picked[field] = step[field];
    });
    return picked;
  });
  return fnv1a(stableStringify(scoped));
}

export function hashSignature(sig: Signature, doc: PlanDoc): boolean {
  return (
    sig.scopeHash === scopeHashOf(sig.role, doc.steps) &&
    sig.orderHash === orderHashOf(doc.steps)
  );
}

export function scopeValuesOf(role: RoleId, steps: LiftStep[]): Record<string, Partial<LiftStep>> {
  const map: Record<string, Partial<LiftStep>> = {};
  steps.forEach((step) => {
    const picked: Partial<LiftStep> = {};
    ROLE_MAP[role].fields.forEach((field) => {
      (picked as Record<string, unknown>)[field] = step[field];
    });
    map[step.id] = picked;
  });
  return map;
}

/** 签署失效原因：仅本人职责内数值或步骤顺序变化才返回原因 */
export function signatureInvalidReasons(sig: Signature, doc: PlanDoc): string[] {
  const reasons: string[] = [];
  if (sig.orderHash !== orderHashOf(doc.steps)) {
    reasons.push('吊装步骤顺序已调整，需全体重新确认');
  }
  const role = ROLE_MAP[sig.role];
  doc.steps.forEach((current) => {
    const old = sig.scopeValues[current.id];
    if (!old) return;
    role.fields.forEach((field) => {
      if (current[field] !== old[field]) {
        reasons.push(`${current.id} ${FIELD_LABELS[field]}：${formatValue(field, old[field])} → ${formatValue(field, current[field])}`);
      }
    });
  });
  return reasons;
}

function formatValue(field: StepField, value: unknown): string {
  if (field === 'siteHandover') return value ? '已移交' : '未移交';
  if (field === 'status') return value === 'passed' ? '通过' : value === 'blocked' ? '阻断' : '待复核';
  return String(value);
}

/** 对比两个步骤集合，返回每个角色职责域内发生变化的字段（用于"别人改的不作废我的签署"之外的提示） */
export function changedFieldsByRole(
  base: LiftStep[],
  next: LiftStep[]
): Record<RoleId, { stepId: string; field: StepField; before: unknown; after: unknown }[]> {
  const result = ROLES.reduce((acc, role) => {
    acc[role.id] = [];
    return acc;
  }, {} as Record<RoleId, { stepId: string; field: StepField; before: unknown; after: unknown }[]>);
  const baseMap = new Map(base.map((step) => [step.id, step]));
  next.forEach((step) => {
    const old = baseMap.get(step.id);
    if (!old) return;
    ROLES.forEach((role) => {
      role.fields.forEach((field) => {
        if (old[field] !== step[field]) {
          result[role.id].push({ stepId: step.id, field, before: old[field], after: step[field] });
        }
      });
    });
  });
  return result;
}

// ---------- 规则冲突 ----------

export function ruleConflictsOf(steps: LiftStep[]): RuleConflict[] {
  return steps.flatMap((step) => {
    const issues: string[] = [];
    if (step.loadRate > 90) issues.push(`荷载率 ${step.loadRate}% 超过 90% 阈值`);
    if (step.clearance < 1.5) issues.push(`净空 ${step.clearance}m 小于 1.5m`);
    if (step.wind > 8) issues.push(`风速 ${step.wind}m/s 超过暂停值`);
    if (step.radius > step.boom * 0.62) issues.push('工作半径接近额定幅度');
    if (!step.siteHandover) issues.push('场地移交未确认');
    return issues.map((message, index) => ({
      id: `${step.id}-${index}`,
      stepId: step.id,
      title: step.title,
      message,
      severity: step.status === 'blocked' ? 'high' : 'medium'
    }));
  });
}

// ---------- 发布门禁 ----------

export type GateState = {
  canPublish: boolean;
  alreadyPublished: boolean;
  signedRoles: RoleId[];
  missingRoles: RoleId[];
  invalidSignatures: { role: RoleId; reasons: string[] }[];
  ruleConflictCount: number;
  pendingConflictCount: number;
  openCommentCount: number;
};

export function evaluateGate(doc: PlanDoc): GateState {
  const byRole = new Map<RoleId, Signature>();
  doc.signatures.forEach((sig) => byRole.set(sig.role, sig));

  const missingRoles: RoleId[] = [];
  const invalidSignatures: { role: RoleId; reasons: string[] }[] = [];
  const signedRoles: RoleId[] = [];

  ROLES.forEach((role) => {
    const sig = byRole.get(role.id);
    if (!sig) {
      missingRoles.push(role.id);
      return;
    }
    const reasons = signatureInvalidReasons(sig, doc);
    if (reasons.length > 0) {
      invalidSignatures.push({ role: role.id, reasons });
    } else {
      signedRoles.push(role.id);
    }
  });

  const ruleConflictCount = ruleConflictsOf(doc.steps).length;
  const pendingConflictCount = doc.conflicts.filter((item) => item.status === 'pending').length;
  const openCommentCount = doc.comments.filter((item) => item.status === 'open').length;
  const currentSnapshotId = snapshotOf(doc.steps);
  // 同一份参数快照只能发布一次，防止无改动重复生成版本
  const alreadyPublished = doc.versions.some((item) => item.snapshotId === currentSnapshotId);

  return {
    canPublish:
      !alreadyPublished &&
      missingRoles.length === 0 &&
      invalidSignatures.length === 0 &&
      ruleConflictCount === 0 &&
      pendingConflictCount === 0 &&
      openCommentCount === 0,
    alreadyPublished,
    signedRoles,
    missingRoles,
    invalidSignatures,
    ruleConflictCount,
    pendingConflictCount,
    openCommentCount
  };
}

// ---------- 初始数据 ----------

export function seedSteps(): LiftStep[] {
  return [
    { id: 'S-01', title: '吊车支腿就位与地耐力复核', time: '07:30', loadRate: 0, clearance: 4.2, wind: 3.4, radius: 18, boom: 42, groundBearing: 180, siteHandover: true, status: 'passed', note: '支腿钢板 2.4m × 2.4m，已完成压实度复检。' },
    { id: 'S-02', title: '空钩回转与障碍物净空检查', time: '08:10', loadRate: 28, clearance: 1.2, wind: 4.1, radius: 22, boom: 46, groundBearing: 170, siteHandover: true, status: 'blocked', note: '东侧临时配电箱侵入回转半径 0.6m。' },
    { id: 'S-03', title: '桁架试吊离地 300mm', time: '08:45', loadRate: 76, clearance: 2.8, wind: 5.2, radius: 20, boom: 44, groundBearing: 175, siteHandover: false, status: 'pending', note: '需安全员确认吊点受力均匀。' },
    { id: 'S-04', title: '主吊回转至安装轴线', time: '09:20', loadRate: 83, clearance: 1.8, wind: 6.8, radius: 24, boom: 48, groundBearing: 172, siteHandover: false, status: 'pending', note: '风速超过 8m/s 立即停止。' },
    { id: 'S-05', title: '双机抬吊姿态调整', time: '10:05', loadRate: 92, clearance: 1.3, wind: 7.2, radius: 27, boom: 52, groundBearing: 165, siteHandover: false, status: 'blocked', note: '辅吊荷载率超过方案控制值。' },
    { id: 'S-06', title: '就位、临时固定与摘钩', time: '10:50', loadRate: 68, clearance: 2.1, wind: 5.6, radius: 21, boom: 45, groundBearing: 178, siteHandover: false, status: 'pending', note: '四组临时螺栓到位后方可摘钩。' }
  ];
}

export function seedComments(): Comment[] {
  const now = '2026-10-03T07:00:00.000Z';
  return [
    { id: 'C-11', author: '周工', role: 'safety', content: 'S-02 回转路径与配电箱净空不足，请调整吊车站位或迁移配电箱。', status: 'open', stepId: 'S-02', createdAt: now },
    { id: 'C-12', author: '刘明', role: 'equipment', content: '辅吊支腿下方需要补充路基板，提供地耐力实测记录。', status: 'open', stepId: 'S-05', createdAt: now },
    { id: 'C-13', author: '陈晓', role: 'general', content: '同意主吊选型，建议把第三检查点前移到试吊阶段。', status: 'resolved', stepId: 'S-03', createdAt: now }
  ];
}

export function seedDoc(): PlanDoc {
  const steps = seedSteps();
  return {
    format: 2,
    planId: 'LP-2026-0918',
    name: '东塔转换桁架吊装',
    revision: 4,
    steps,
    comments: seedComments(),
    signatures: [],
    conflicts: [],
    versions: [],
    updatedAt: new Date().toISOString()
  };
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
