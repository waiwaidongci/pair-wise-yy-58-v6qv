import { defineStore } from 'pinia';
import { graphqlClient, LIFT_PLAN_QUERY, LIFT_VERSIONS_QUERY } from './graphql';
import {
  clone,
  Comment,
  evaluateGate,
  GateState,
  LiftStep,
  orderHashOf,
  PendingConflict,
  PlanDoc,
  PublishedVersion,
  RoleId,
  ROLE_MAP,
  ROLES,
  RuleConflict,
  ruleConflictsOf,
  scopeHashOf,
  scopeValuesOf,
  Signature,
  snapshotOf,
  StepField,
  FIELD_LABELS
} from './snapshot';
import {
  clearWindowDraft,
  commitDoc,
  draftKey,
  loadDoc,
  loadWindowDraft,
  pruneStaleDrafts,
  saveWindowDraft,
  WindowDraft
} from './storage';

export type CommitOutcome =
  | { ok: true; revision: number }
  | { ok: false; kind: 'conflict-queued' | 'rejected'; message: string; conflictId?: string };

type EditKind = 'edit' | 'reorder' | 'sign' | 'comment' | 'resolve' | 'publish' | 'review';

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * 所有修改以事务方式提交：
 * mutate 在草案上执行 → CAS 落盘 → 成功才替换内存状态；
 * 失败（其他窗口先提交）则把本次意图登记为待复核冲突，绝不覆盖先到结果。
 */
function buildConflict(
  kind: Exclude<EditKind, 'publish' | 'review'>,
  role: RoleId,
  baseRevision: number,
  landedRevision: number,
  summary: string,
  detail: string,
  payload: Partial<PendingConflict>
): PendingConflict {
  return {
    id: uid('CF'),
    kind,
    role,
    author: ROLE_MAP[role].name,
    summary,
    detail,
    baseRevision,
    landedRevision,
    status: 'pending',
    createdAt: new Date().toISOString(),
    ...payload
  };
}

export const useLiftStore = defineStore('lift-plan', {
  state: () => {
    const doc = loadDoc();
    const windowId =
      typeof sessionStorage !== 'undefined' && sessionStorage.getItem('yy58-window-id')
        ? (sessionStorage.getItem('yy58-window-id') as string)
        : uid('WIN');
    if (typeof sessionStorage !== 'undefined') sessionStorage.setItem('yy58-window-id', windowId);

    return {
      windowId,
      doc,
      selectedStepId: doc.steps.some((step) => step.id === 'S-02') ? 'S-02' : doc.steps[0]?.id ?? '',
      activeRole: 'general' as RoleId,
      commentText: '',
      gate: evaluateGate(doc) as GateState,
      recoveredDrafts: [] as WindowDraft[],
      lastCommitAt: null as string | null,
      publishError: ''
    };
  },
  getters: {
    steps(state): LiftStep[] {
      return state.doc.steps;
    },
    comments(state): Comment[] {
      return state.doc.comments;
    },
    conflicts(): RuleConflict[] {
      return ruleConflictsOf(this.doc.steps);
    },
    pendingConflicts(state): PendingConflict[] {
      return state.doc.conflicts.filter((item) => item.status === 'pending');
    },
    resolvedConflicts(state): PendingConflict[] {
      return state.doc.conflicts.filter((item) => item.status !== 'pending');
    },
    openComments(state): Comment[] {
      return state.doc.comments.filter((comment) => comment.status === 'open');
    },
    signatures(state): Signature[] {
      return state.doc.signatures;
    },
    versions(state): PublishedVersion[] {
      return state.doc.versions;
    },
    latestVersion(state): PublishedVersion | null {
      return state.doc.versions.length ? state.doc.versions[state.doc.versions.length - 1] : null;
    },
    locked(): boolean {
      const current = snapshotOf(this.doc.steps);
      return this.doc.versions.some((item) => item.snapshotId === current);
    },
    currentSnapshotId(state): string {
      return snapshotOf(state.doc.steps);
    },
    selectedStep(state): LiftStep {
      return state.doc.steps.find((step) => step.id === state.selectedStepId) ?? state.doc.steps[0];
    },
    signatureByRole(state): Record<RoleId, Signature | undefined> {
      const map = {} as Record<RoleId, Signature | undefined>;
      state.doc.signatures.forEach((sig) => {
        // 同一角色只保留最近一次有效签署记录位置
        map[sig.role] = sig;
      });
      return map;
    },
    readiness(state): number {
      const gate = evaluateGate(state.doc);
      let score = (gate.signedRoles.length * 20) + (state.doc.steps.filter((s) => s.status === 'passed').length / Math.max(1, state.doc.steps.length)) * 20;
      score -= gate.ruleConflictCount * 6 + gate.openCommentCount * 6 + gate.pendingConflictCount * 8;
      return Math.max(0, Math.min(100, Math.round(score)));
    }
  },
  actions: {
    init() {
      // 恢复本窗口崩溃前未提交的编辑草稿；其他窗口残留草稿一并提示
      const own = loadWindowDraft(this.windowId);
      const orphans = pruneStaleDrafts(this.windowId);
      this.recoveredDrafts = own ? [own, ...orphans.filter((d) => d.windowId !== this.windowId)] : orphans;
      if (typeof window !== 'undefined') {
        window.addEventListener('storage', this.onStorage);
        window.addEventListener('beforeunload', () => clearWindowDraft(this.windowId));
      }
      this.refreshGate();
    },

    onStorage(event: StorageEvent) {
      if (!event.key || !event.key.startsWith('yy58-lift-plan-doc')) return;
      // 其他窗口完成了提交：同步最新文档（当前未提交编辑保留在窗口草稿中，不会被吞掉）
      const latest = loadDoc();
      if (latest.revision !== this.doc.revision) {
        this.doc = latest;
        this.refreshGate();
      }
    },

    refreshGate() {
      this.gate = evaluateGate(this.doc);
    },

    selectStep(id: string) {
      this.selectedStepId = id;
    },

    setActiveRole(role: RoleId) {
      this.activeRole = role;
    },

    // ---------- 窗口草稿：未提交编辑崩溃恢复 ----------
    stashDraft(patch: Record<string, unknown>, order: string[] | null = null, commentDraft?: string) {
      saveWindowDraft(this.windowId, {
        stepId: this.selectedStepId,
        patch,
        order,
        commentDraft: commentDraft ?? this.commentText
      });
    },
    clearStash() {
      clearWindowDraft(this.windowId);
    },
    dismissRecoveredDraft(windowId: string) {
      this.recoveredDrafts = this.recoveredDrafts.filter((draft) => draft.windowId !== windowId);
      if (windowId === this.windowId) this.clearStash();
      else if (typeof localStorage !== 'undefined') localStorage.removeItem(draftKey(windowId));
    },

    // ---------- 核心事务 ----------
    _transact(
      mutate: (draft: PlanDoc) => void,
      onConflict: (latest: PlanDoc) => { queue: boolean; conflict?: PendingConflict } | null
    ): CommitOutcome {
      const baseRevision = this.doc.revision;
      const draft = clone(this.doc);
      mutate(draft);
      draft.revision = baseRevision + 1;
      draft.updatedAt = new Date().toISOString();

      const result = commitDoc(baseRevision, draft);
      if (result.ok) {
        this.doc = result.doc;
        this.lastCommitAt = new Date().toISOString();
        this.refreshGate();
        return { ok: true, revision: this.doc.revision };
      }

      // CAS 失败：先到结果已落盘，本次修改不覆盖，登记冲突留待复核
      const decision = onConflict(result.latest);
      if (decision?.queue && decision.conflict) {
        const queueDraft = clone(result.latest);
        queueDraft.conflicts.push(decision.conflict);
        // 冲突登记本身也是一次落盘提交，版本号必须前进一步，避免两份文档共用 revision
        queueDraft.revision = result.latest.revision + 1;
        queueDraft.updatedAt = new Date().toISOString();
        const queued = commitDoc(result.latest.revision, queueDraft);
        if (queued.ok) {
          this.doc = queued.doc;
          this.refreshGate();
          return { ok: false, kind: 'conflict-queued', message: '其他窗口已先提交，本次修改已留存待复核', conflictId: decision.conflict.id };
        }
        // 登记时又被抢先：直接同步最新状态，提示重试
        this.doc = loadDoc();
        this.refreshGate();
        return { ok: false, kind: 'rejected', message: '冲突登记也发生竞争，请刷新后重试' };
      }
      this.doc = result.latest;
      this.refreshGate();
      return { ok: false, kind: 'rejected', message: '版本已变化，本次提交被拒绝' };
    },

    /** 编辑单个步骤；只有落在签署者职责域内的字段变化，才在下次门禁时让其签署失效 */
    updateStep(stepId: string, patch: Partial<LiftStep>, roleArg?: RoleId): CommitOutcome {
      const role: RoleId = roleArg ?? this.activeRole;
      const current = this.doc.steps.find((s) => s.id === stepId);
      if (!current) return { ok: false, kind: 'rejected', message: '步骤不存在' };
      const changedFields = (Object.keys(patch) as StepField[]).filter((key) => current[key] !== patch[key]);
      if (changedFields.length === 0) return { ok: false, kind: 'rejected', message: '没有实际变化' };
      const snapshotPatch = clone(patch);
      this.clearStash();
      return this._transact(
        (draft) => {
          const target = draft.steps.find((s) => s.id === stepId);
          if (target) Object.assign(target, snapshotPatch);
        },
        (latest) => {
          const labels = changedFields.map((f) => FIELD_LABELS[f]).join('、');
          return {
            queue: true,
            conflict: buildConflict(
              'edit',
              role,
              this.doc.revision,
              latest.revision,
              `${stepId} 参数修改（${labels}）`,
              `本窗口基于 V${this.doc.revision} 修改 ${labels}，另一窗口已先提交 V${latest.revision}，修改未覆盖先到结果。`,
              { stepsPatch: { [stepId]: snapshotPatch } }
            )
          };
        }
      );
    },

    /** 调整步骤顺序：顺序属全体共享项，会令四个角色签署全部失效，需重新确认 */
    reorderSteps(orderedIds: string[], roleArg?: RoleId): CommitOutcome {
      const role: RoleId = roleArg ?? this.activeRole;
      if (orderedIds.length !== this.doc.steps.length) return { ok: false, kind: 'rejected', message: '步骤数量不一致' };
      this.clearStash();
      return this._transact(
        (draft) => {
          const map = new Map(draft.steps.map((s) => [s.id, s]));
          draft.steps = orderedIds.map((id) => map.get(id)!).filter(Boolean);
        },
        (latest) => ({
          queue: true,
          conflict: buildConflict(
            'reorder',
            role,
            this.doc.revision,
            latest.revision,
            '吊装步骤顺序调整',
            `本窗口基于 V${this.doc.revision} 调整步骤顺序，另一窗口已先提交 V${latest.revision}。`,
            { orderedStepIds: orderedIds }
          )
        })
      );
    },
    moveStep(stepId: string, delta: -1 | 1): CommitOutcome {
      const index = this.doc.steps.findIndex((s) => s.id === stepId);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= this.doc.steps.length) {
        return { ok: false, kind: 'rejected', message: '无法继续移动' };
      }
      const ids = this.doc.steps.map((s) => s.id);
      [ids[index], ids[target]] = [ids[target], ids[index]];
      return this.reorderSteps(ids);
    },

    /** 会签：把签署绑到当前全量快照 + 本角色职责域哈希 + 顺序哈希 */
    sign(role: RoleId, signer = ROLE_MAP[role].name): CommitOutcome {
      if (this.locked) return { ok: false, kind: 'rejected', message: '当前快照已发布，新版本需重新会签' };
      const existing = this.doc.signatures.find((s) => s.role === role);
      const steps = clone(this.doc.steps);
      const signature: Signature = {
        role,
        signer,
        revision: this.doc.revision,
        snapshotId: snapshotOf(steps),
        scopeHash: scopeHashOf(role, steps),
        orderHash: orderHashOf(steps),
        scopeValues: scopeValuesOf(role, steps),
        orderIds: steps.map((s) => s.id),
        signedAt: new Date().toISOString()
      };
      return this._transact(
        (draft) => {
          draft.signatures = draft.signatures.filter((s) => s.role !== role);
          draft.signatures.push(signature);
        },
        (latest) => ({
          queue: existing ? false : true,
          conflict: existing
            ? undefined
            : buildConflict(
                'sign',
                role,
                this.doc.revision,
                latest.revision,
                `${ROLE_MAP[role].name} 会签确认`,
                `本窗口基于 V${this.doc.revision} 完成会签时，另一窗口已先提交 V${latest.revision}，请在最新快照上重新确认。`,
                {}
              )
        })
      );
    },

    addComment(content: string, roleArg?: RoleId): CommitOutcome {
      const role: RoleId = roleArg ?? this.activeRole;
      const text = content.trim();
      if (!text) return { ok: false, kind: 'rejected', message: '意见内容为空' };
      const stepId = this.selectedStepId;
      const comment: Comment = {
        id: uid('C'),
        author: ROLE_MAP[role].name,
        role,
        content: text,
        status: 'open',
        stepId,
        createdAt: new Date().toISOString()
      };
      this.commentText = '';
      return this._transact(
        (draft) => {
          draft.comments.unshift(comment);
        },
        (latest) => ({
          queue: true,
          conflict: buildConflict(
            'comment',
            role,
            this.doc.revision,
            latest.revision,
            `${ROLE_MAP[role].name} 的条件意见`,
            `本窗口基于 V${this.doc.revision} 提交意见，另一窗口已先提交 V${latest.revision}。`,
            { comment: { stepId, content: text } }
          )
        })
      );
    },

    resolveComment(id: string, roleArg?: RoleId): CommitOutcome {
      const role: RoleId = roleArg ?? this.activeRole;
      return this._transact(
        (draft) => {
          const item = draft.comments.find((c) => c.id === id);
          if (item) item.status = 'resolved';
        },
        (latest) => ({
          queue: true,
          conflict: buildConflict(
            'resolve',
            role,
            this.doc.revision,
            latest.revision,
            `关闭意见 ${id}`,
            `本窗口基于 V${this.doc.revision} 关闭意见，另一窗口已先提交 V${latest.revision}。`,
            { resolveCommentId: id }
          )
        })
      );
    },

    // ---------- 待复核冲突：放弃或复核后重新套用 ----------
    abandonConflict(id: string): CommitOutcome {
      return this._transact((draft) => {
        const item = draft.conflicts.find((c) => c.id === id);
        if (item) item.status = 'abandoned';
      }, () => null);
    },

    /** 复核通过：以最新文档为基线重新套用后提交者的意图；若仍冲突则继续保留 */
    reapplyConflict(id: string, roleArg?: RoleId): CommitOutcome {
      const role: RoleId = roleArg ?? this.activeRole;
      const item = this.doc.conflicts.find((c) => c.id === id);
      if (!item || item.status !== 'pending') return { ok: false, kind: 'rejected', message: '冲突不存在或已处理' };

      return this._transact(
        (draft) => {
          if (item.kind === 'edit' && item.stepsPatch) {
            Object.entries(item.stepsPatch).forEach(([stepId, patch]) => {
              const target = draft.steps.find((s) => s.id === stepId);
              if (target) Object.assign(target, patch);
            });
          } else if (item.kind === 'reorder' && item.orderedStepIds) {
            const known = new Set(draft.steps.map((s) => s.id));
            if (item.orderedStepIds.every((id) => known.has(id))) {
              const map = new Map(draft.steps.map((s) => [s.id, s]));
              draft.steps = item.orderedStepIds.map((id) => map.get(id)!);
            }
          } else if (item.kind === 'comment' && item.comment) {
            draft.comments.unshift({
              id: uid('C'),
              author: item.author,
              role: item.role,
              content: item.comment.content,
              status: 'open',
              stepId: item.comment.stepId,
              createdAt: new Date().toISOString()
            });
          } else if (item.kind === 'resolve' && item.resolveCommentId) {
            const target = draft.comments.find((c) => c.id === item.resolveCommentId);
            if (target) target.status = 'resolved';
          } else if (item.kind === 'sign') {
            const steps = draft.steps;
            draft.signatures = draft.signatures.filter((s) => s.role !== item.role);
            draft.signatures.push({
              role: item.role,
              signer: item.author,
              revision: draft.revision,
              snapshotId: snapshotOf(steps),
              scopeHash: scopeHashOf(item.role, steps),
              orderHash: orderHashOf(steps),
              scopeValues: scopeValuesOf(item.role, steps),
              orderIds: steps.map((s) => s.id),
              signedAt: new Date().toISOString()
            });
          }
          const queued = draft.conflicts.find((c) => c.id === id);
          if (queued) queued.status = 'reapplied';
        },
        (latest) => ({ queue: false })
      );
    },

    // ---------- 原子发布 ----------
    /**
     * 发布门禁在提交事务内、对即将落盘的草案复核：
     * 四角色签署全部有效 + 规则冲突清零 + 并发冲突清零 + 评论清零，
     * 全部满足才一次性生成不可变新版本，否则整笔回滚（不产生任何 revision）。
     */
    publish(roleArg?: RoleId): CommitOutcome {
      const role: RoleId = roleArg ?? this.activeRole;
      this.publishError = '';
      const precheck = evaluateGate(this.doc);
      if (!precheck.canPublish) {
        const blockers: string[] = [];
        if (precheck.alreadyPublished) blockers.push('当前快照已发布，需修改参数并重新会签后才能生成新版本');
        if (precheck.missingRoles.length) blockers.push(`缺少签署：${precheck.missingRoles.map((r) => ROLE_MAP[r].name).join('、')}`);
        if (precheck.invalidSignatures.length) blockers.push('存在已失效的签署，需重新确认');
        if (precheck.ruleConflictCount) blockers.push(`规则冲突 ${precheck.ruleConflictCount} 项未清零`);
        if (precheck.pendingConflictCount) blockers.push(`并发冲突 ${precheck.pendingConflictCount} 项待复核`);
        if (precheck.openCommentCount) blockers.push(`未关闭意见 ${precheck.openCommentCount} 条`);
        this.publishError = blockers.join('；');
        return { ok: false, kind: 'rejected', message: this.publishError };
      }

      const baseRevision = this.doc.revision;
      const draft = clone(this.doc);

      // 事务内对即将落盘的草案做最终门禁复核，杜绝校验后被其他窗口插入修改
      const inTxGate = evaluateGate(draft);
      if (!inTxGate.canPublish) {
        this.publishError = '提交前快照已变化，请在最新版本上复核';
        return { ok: false, kind: 'rejected', message: this.publishError };
      }

      const publishedAt = new Date().toISOString();
      const version: PublishedVersion = {
        revision: baseRevision + 1,
        snapshotId: snapshotOf(draft.steps),
        publishedAt,
        publisher: ROLE_MAP[role].name,
        steps: clone(draft.steps),
        comments: clone(draft.comments),
        signatures: clone(draft.signatures)
      };
      draft.revision = version.revision;
      draft.updatedAt = publishedAt;
      draft.versions.push(version);

      const result = commitDoc(baseRevision, draft);
      if (!result.ok) {
        this.doc = result.latest;
        this.refreshGate();
        this.publishError = `另一窗口已先提交 V${result.latest.revision}，发布未执行，请重新核门禁`;
        return { ok: false, kind: 'rejected', message: this.publishError };
      }

      this.doc = result.doc;
      this.refreshGate();
      this.syncPublishedToApollo(version);
      return { ok: true, revision: version.revision };
    },

    syncPublishedToApollo(version: PublishedVersion) {
      graphqlClient.writeQuery({
        query: LIFT_PLAN_QUERY,
        variables: { id: this.doc.planId },
        data: {
          liftPlan: {
            __typename: 'LiftPlan',
            id: this.doc.planId,
            name: this.doc.name,
            revision: version.revision,
            snapshotId: version.snapshotId,
            publishedAt: version.publishedAt,
            status: 'LOCKED',
            steps: version.steps.map((step) => ({
              __typename: 'LiftStep',
              id: step.id,
              name: step.title,
              loadRate: step.loadRate,
              clearance: step.clearance
            }))
          }
        }
      });
      graphqlClient.writeQuery({
        query: LIFT_VERSIONS_QUERY,
        variables: { id: this.doc.planId },
        data: {
          liftPlanVersions: {
            __typename: 'LiftPlanVersionConnection',
            id: this.doc.planId,
            versions: this.doc.versions.map((item) => ({
              __typename: 'LiftPlanVersion',
              revision: item.revision,
              snapshotId: item.snapshotId,
              publishedAt: item.publishedAt,
              publisher: item.publisher
            }))
          }
        }
      });
    }
  }
});

export { ROLES };
