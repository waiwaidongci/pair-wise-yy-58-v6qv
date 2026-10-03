import { defineStore } from 'pinia';
import { graphqlClient, LIFT_PLAN_QUERY } from './graphql';

export type StepStatus = 'pending' | 'passed' | 'blocked';
export type Comment = {
  id: string;
  author: string;
  role: string;
  content: string;
  status: 'open' | 'resolved';
  stepId: string;
};

export type LiftStep = {
  id: string;
  title: string;
  time: string;
  loadRate: number;
  clearance: number;
  wind: number;
  radius: number;
  boom: number;
  status: StepStatus;
  note: string;
};

// 职责角色：总包（工序顺序）、设备（吊车参数）、安全（净空风速）、方案（载荷计算）
export type RoleId = 'general' | 'equipment' | 'safety' | 'engineering';
export type SignoffStatus = 'pending' | 'signed' | 'invalidated';

export type Signoff = {
  role: RoleId;
  name: string;
  team: string;
  scope: string;
  status: SignoffStatus;
  signedAt: string | null;
  signedDigest: string | null;
  signedValues: Record<string, string | number> | null;
  invalidReason?: string;
};

// 每个角色职责内的字段：只有这些字段（或步骤顺序）变化才会让对应签署失效
const FIELD_OWNER: Partial<Record<keyof LiftStep, RoleId>> = {
  loadRate: 'engineering',
  radius: 'equipment',
  boom: 'equipment',
  clearance: 'safety',
  wind: 'safety'
};

const FIELD_LABELS: Record<string, string> = {
  loadRate: '荷载率',
  radius: '作业半径',
  boom: '臂长',
  clearance: '净空',
  wind: '风速',
  __order__: '步骤顺序'
};

function hashString(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const initialSteps: LiftStep[] = [
  { id: 'S-01', title: '吊车支腿就位与地耐力复核', time: '07:30', loadRate: 0, clearance: 4.2, wind: 3.4, radius: 18, boom: 42, status: 'passed', note: '支腿钢板 2.4m × 2.4m，已完成压实度复检。' },
  { id: 'S-02', title: '空钩回转与障碍物净空检查', time: '08:10', loadRate: 28, clearance: 1.2, wind: 4.1, radius: 22, boom: 46, status: 'blocked', note: '东侧临时配电箱侵入回转半径 0.6m。' },
  { id: 'S-03', title: '桁架试吊离地 300mm', time: '08:45', loadRate: 76, clearance: 2.8, wind: 5.2, radius: 20, boom: 44, status: 'pending', note: '需安全员确认吊点受力均匀。' },
  { id: 'S-04', title: '主吊回转至安装轴线', time: '09:20', loadRate: 83, clearance: 1.8, wind: 6.8, radius: 24, boom: 48, status: 'pending', note: '风速超过 8m/s 立即停止。' },
  { id: 'S-05', title: '双机抬吊姿态调整', time: '10:05', loadRate: 92, clearance: 1.3, wind: 7.2, radius: 27, boom: 52, status: 'blocked', note: '辅吊荷载率超过方案控制值。' },
  { id: 'S-06', title: '就位、临时固定与摘钩', time: '10:50', loadRate: 68, clearance: 2.1, wind: 5.6, radius: 21, boom: 45, status: 'pending', note: '四组临时螺栓到位后方可摘钩。' }
];

const initialComments: Comment[] = [
  { id: 'C-11', author: '周工', role: '安全', content: 'S-02 回转路径与配电箱净空不足，请调整吊车站位或迁移配电箱。', status: 'open', stepId: 'S-02' },
  { id: 'C-12', author: '刘明', role: '设备', content: '辅吊支腿下方需要补充路基板，提供地耐力实测记录。', status: 'open', stepId: 'S-05' },
  { id: 'C-13', author: '陈晓', role: '总包', content: '同意主吊选型，建议把第三检查点前移到试吊阶段。', status: 'resolved', stepId: 'S-03' }
];

const initialSignoffs: Signoff[] = [
  { role: 'general', name: '陈晓', team: '总包项目部', scope: '吊装工序与场地移交（含步骤顺序）', status: 'pending', signedAt: null, signedDigest: null, signedValues: null },
  { role: 'equipment', name: '刘明', team: '设备管理', scope: '吊车参数与支腿地基（臂长、作业半径）', status: 'pending', signedAt: null, signedDigest: null, signedValues: null },
  { role: 'safety', name: '周工', team: '安全监督', scope: '净空、风速与警戒区', status: 'pending', signedAt: null, signedDigest: null, signedValues: null },
  { role: 'engineering', name: '赵磊', team: '方案工程', scope: '载荷计算与路径参数（荷载率）', status: 'pending', signedAt: null, signedDigest: null, signedValues: null }
];

export type PlanSnapshot = {
  revision: number;
  seq: number;
  locked: boolean;
  steps: LiftStep[];
  comments: Comment[];
  signoffs: Signoff[];
  selectedStepId: string;
  viewBookmarks: string[];
  activeBookmark: string;
  draftSavedAt: string;
};

const cacheKey = 'yy58-lift-plan-draft';

function readSnapshot(): Partial<PlanSnapshot> | null {
  if (typeof localStorage === 'undefined') return null;
  const raw = localStorage.getItem(cacheKey);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Partial<PlanSnapshot>;
  } catch {
    return null;
  }
}

const saved = readSnapshot();

export type CommitResult = { ok: true } | { ok: false; reason: 'conflict' | 'gate'; remoteSeq?: number };

export const useLiftStore = defineStore('lift-plan', {
  state: () => ({
    steps: (saved?.steps as LiftStep[]) ?? initialSteps,
    comments: (saved?.comments as Comment[]) ?? initialComments,
    signoffs: (saved?.signoffs as Signoff[]) ?? initialSignoffs,
    selectedStepId: (saved?.selectedStepId as string) ?? 'S-02',
    revision: (saved?.revision as number) ?? 4,
    seq: (saved?.seq as number) ?? 0,
    locked: (saved?.locked as boolean) ?? false,
    viewBookmarks: (saved?.viewBookmarks as string[]) ?? ['主吊全景', '东侧障碍', '安装轴线'],
    activeBookmark: (saved?.activeBookmark as string) ?? '主吊全景',
    remoteConflict: false,
    remoteSeq: 0
  }),
  getters: {
    selectedStep(state): LiftStep {
      return state.steps.find((step) => step.id === state.selectedStepId) ?? state.steps[0];
    },
    conflicts(state) {
      return state.steps.flatMap((step) => {
        const issues: string[] = [];
        if (step.loadRate > 90) issues.push(`荷载率 ${step.loadRate}% 超过 90% 阈值`);
        if (step.clearance < 1.5) issues.push(`净空 ${step.clearance}m 小于 1.5m`);
        if (step.wind > 8) issues.push(`风速 ${step.wind}m/s 超过暂停值`);
        if (step.radius > step.boom * 0.62) issues.push('工作半径接近额定幅度');
        return issues.map((message, index) => ({ id: `${step.id}-${index}`, stepId: step.id, title: step.title, message, severity: step.status === 'blocked' ? 'high' : 'medium' }));
      });
    },
    openComments(state) {
      return state.comments.filter((comment) => comment.status === 'open');
    },
    signedCount(state) {
      return state.signoffs.filter((s) => s.status === 'signed').length;
    },
    gateReady(): boolean {
      return !this.locked && this.signoffs.every((s) => s.status === 'signed') && this.conflicts.length === 0 && this.openComments.length === 0;
    },
    readiness(state): number {
      const passedChecks = state.steps.filter((step) => step.status === 'passed').length;
      const commentPenalty = state.comments.filter((item) => item.status === 'open').length * 12;
      return Math.max(0, Math.round((passedChecks / state.steps.length) * 100 - commentPenalty));
    }
  },
  actions: {
    // 收集某角色职责内的当前值（用于签署摘要比对）
    collectRoleValues(role: RoleId): Record<string, string | number> {
      const out: Record<string, string | number> = {};
      if (role === 'general') {
        out.__order__ = this.steps.map((s) => s.id).join(',');
        return out;
      }
      for (const s of this.steps) {
        if (role === 'engineering') out[`${s.id}.loadRate`] = s.loadRate;
        if (role === 'equipment') {
          out[`${s.id}.radius`] = s.radius;
          out[`${s.id}.boom`] = s.boom;
        }
        if (role === 'safety') {
          out[`${s.id}.clearance`] = s.clearance;
          out[`${s.id}.wind`] = s.wind;
        }
      }
      return out;
    },
    // 提交前检查乐观并发序号：后提交者不能覆盖先到结果
    checkRemote(): boolean {
      const latest = readSnapshot();
      if (latest && typeof latest.seq === 'number' && latest.seq !== this.seq) {
        this.remoteConflict = true;
        this.remoteSeq = latest.seq;
        return true;
      }
      return false;
    },
    ownerOfField(field: keyof LiftStep): Signoff | undefined {
      const role = FIELD_OWNER[field];
      return role ? this.signoffs.find((s) => s.role === role) : undefined;
    },
    // 步骤参数提交：只做局部修改，不连带作废无关角色的签署
    commitStep(patch: Partial<LiftStep>): CommitResult {
      if (this.locked) return { ok: false, reason: 'gate' };
      if (this.checkRemote()) return { ok: false, reason: 'conflict', remoteSeq: this.remoteSeq };
      const index = this.steps.findIndex((step) => step.id === this.selectedStepId);
      if (index < 0) return { ok: false, reason: 'gate' };
      this.steps[index] = { ...this.steps[index], ...patch };
      this.seq += 1;
      this.revalidateSignoffs();
      this.persist();
      return { ok: true };
    },
    // 步骤顺序调整：仅作废总包（工序顺序）签署
    reorderStep(direction: -1 | 1): CommitResult {
      if (this.locked) return { ok: false, reason: 'gate' };
      if (this.checkRemote()) return { ok: false, reason: 'conflict', remoteSeq: this.remoteSeq };
      const index = this.steps.findIndex((step) => step.id === this.selectedStepId);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= this.steps.length) return { ok: false, reason: 'gate' };
      const next = [...this.steps];
      [next[index], next[target]] = [next[target], next[index]];
      this.steps = next;
      this.seq += 1;
      const general = this.signoffs.find((s) => s.role === 'general');
      if (general && general.status === 'signed') {
        general.status = 'invalidated';
        general.invalidReason = '吊装步骤顺序已调整，需重新确认工序与场地移交顺序';
      }
      this.persist();
      return { ok: true };
    },
    // 重新校验签署：只有本人职责内数值变化才失效
    revalidateSignoffs() {
      for (const signoff of this.signoffs) {
        if (signoff.status !== 'signed' || !signoff.signedValues) continue;
        const current = this.collectRoleValues(signoff.role);
        const changedKeys = Object.keys(current).filter((k) => current[k] !== signoff.signedValues![k]);
        if (changedKeys.length > 0) {
          const labels = changedKeys.map((k) => FIELD_LABELS[k.split('.').pop() ?? k] ?? k);
          signoff.status = 'invalidated';
          signoff.invalidReason = `职责内参数变化（${labels.join('、')}），需重新签署确认`;
        }
      }
    },
    // 角色签署：绑定其职责字段摘要到当前快照
    sign(role: RoleId): CommitResult {
      if (this.locked) return { ok: false, reason: 'gate' };
      if (this.checkRemote()) return { ok: false, reason: 'conflict', remoteSeq: this.remoteSeq };
      const target = this.signoffs.find((s) => s.role === role);
      if (!target) return { ok: false, reason: 'gate' };
      const values = this.collectRoleValues(role);
      target.status = 'signed';
      target.signedAt = new Date().toISOString();
      target.signedValues = values;
      target.signedDigest = hashString(JSON.stringify(values));
      target.invalidReason = undefined;
      this.seq += 1;
      this.persist();
      return { ok: true };
    },
    addComment(content: string, author = '王工', role = '方案'): CommitResult {
      if (!content.trim()) return { ok: false, reason: 'gate' };
      if (this.locked) return { ok: false, reason: 'gate' };
      if (this.checkRemote()) return { ok: false, reason: 'conflict', remoteSeq: this.remoteSeq };
      this.comments.unshift({ id: `C-${Date.now()}`, author, role, content, status: 'open', stepId: this.selectedStepId });
      this.seq += 1;
      this.persist();
      return { ok: true };
    },
    resolveComment(id: string): CommitResult {
      if (this.locked) return { ok: false, reason: 'gate' };
      if (this.checkRemote()) return { ok: false, reason: 'conflict', remoteSeq: this.remoteSeq };
      const item = this.comments.find((comment) => comment.id === id);
      if (!item || item.status === 'resolved') return { ok: false, reason: 'gate' };
      item.status = 'resolved';
      this.seq += 1;
      this.persist();
      return { ok: true };
    },
    selectStep(id: string) {
      this.selectedStepId = id;
      this.persist();
    },
    setBookmark(name: string) {
      this.activeBookmark = name;
      if (!this.viewBookmarks.includes(name)) this.viewBookmarks.push(name);
      this.persist();
    },
    // 原子发布：签署有效、冲突与评论清零时才生成新版本
    publish(): CommitResult {
      if (this.locked) return { ok: false, reason: 'gate' };
      if (this.checkRemote()) return { ok: false, reason: 'conflict', remoteSeq: this.remoteSeq };
      if (!this.gateReady) return { ok: false, reason: 'gate' };
      this.revision += 1;
      this.seq += 1;
      this.locked = true;
      this.persist();
      graphqlClient.writeQuery({
        query: LIFT_PLAN_QUERY,
        variables: { id: 'LP-2026-0918' },
        data: {
          liftPlan: {
            __typename: 'LiftPlan',
            id: 'LP-2026-0918',
            name: '东塔转换桁架吊装',
            revision: this.revision,
            status: 'LOCKED',
            steps: JSON.parse(JSON.stringify(this.steps)),
            signoffs: JSON.parse(JSON.stringify(this.signoffs))
          }
        }
      });
      return { ok: true };
    },
    reloadSnapshot() {
      const latest = readSnapshot();
      if (latest) this.applySnapshot(latest as PlanSnapshot);
      this.remoteConflict = false;
      this.remoteSeq = 0;
    },
    applySnapshot(snapshot: PlanSnapshot) {
      this.steps = snapshot.steps;
      this.comments = snapshot.comments;
      this.signoffs = snapshot.signoffs;
      this.selectedStepId = snapshot.selectedStepId;
      this.revision = snapshot.revision;
      this.seq = snapshot.seq;
      this.locked = snapshot.locked;
      this.viewBookmarks = snapshot.viewBookmarks;
      this.activeBookmark = snapshot.activeBookmark;
    },
    persist() {
      if (typeof localStorage === 'undefined') return;
      const snapshot: PlanSnapshot = {
        revision: this.revision,
        seq: this.seq,
        locked: this.locked,
        steps: JSON.parse(JSON.stringify(this.steps)),
        comments: JSON.parse(JSON.stringify(this.comments)),
        signoffs: JSON.parse(JSON.stringify(this.signoffs)),
        selectedStepId: this.selectedStepId,
        viewBookmarks: [...this.viewBookmarks],
        activeBookmark: this.activeBookmark,
        draftSavedAt: new Date().toISOString()
      };
      localStorage.setItem(cacheKey, JSON.stringify(snapshot));
    }
  }
});

// 其他窗口提交后，当前窗口收到 storage 事件：不自动覆盖，提示留待复核
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== cacheKey || !event.newValue) return;
    try {
      const remote = JSON.parse(event.newValue) as Partial<PlanSnapshot>;
      const store = useLiftStore();
      if (typeof remote.seq === 'number' && remote.seq > store.seq) {
        store.remoteConflict = true;
        store.remoteSeq = remote.seq;
      }
    } catch {
      /* 忽略损坏的远端数据 */
    }
  });
}
