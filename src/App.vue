<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import * as THREE from 'three';
import { useLiftStore, type CommitOutcome } from './store';
import { FIELD_LABELS, LiftStep, RoleId, ROLE_MAP, ROLES, signatureInvalidReasons, StepField } from './snapshot';

const route = useRoute();
const router = useRouter();
const store = useLiftStore();
const canvasRef = ref<HTMLCanvasElement | null>(null);
const sceneContainer = ref<HTMLElement | null>(null);
const commentText = ref('');
const toast = ref<{ text: string; tone: 'ok' | 'warn' | 'err' } | null>(null);
let toastTimer: ReturnType<typeof setTimeout> | null = null;

let renderer: THREE.WebGLRenderer | null = null;
let frame = 0;
let resizeObserver: ResizeObserver | null = null;
let theta = 0.8;
let phi = 0.9;
let dragging = false;
let previousX = 0;

const nav = [
  { path: '/', label: '三维复核', icon: 'view_in_ar' },
  { path: '/models', label: '模型与参数', icon: 'tune' },
  { path: '/checks', label: '冲突与评论', icon: 'rule' },
  { path: '/review', label: '多角色会签', icon: 'fact_check' }
];

const pageTitle = computed(() => nav.find((item) => item.path === route.path)?.label ?? '吊装工作台');

const viewBookmarks = ref(['主吊全景', '东侧障碍', '安装轴线']);
const activeBookmark = ref('主吊全景');

function setBookmark(name: string) {
  activeBookmark.value = name;
  if (!viewBookmarks.value.includes(name)) viewBookmarks.value.push(name);
}

function showToast(text: string, tone: 'ok' | 'warn' | 'err' = 'ok') {
  toast.value = { text, tone };
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = null), 3600);
}

function report(result: CommitOutcome, okText: string) {
  if (result.ok) showToast(okText, 'ok');
  else showToast(result.message ?? '操作未成功', result.kind === 'conflict-queued' ? 'warn' : 'err');
}

// ---------- 本地编辑缓冲：未提交修改崩溃后可恢复，提交走 CAS 事务 ----------
const buffer = reactive<{
  time: string;
  loadRate: number;
  clearance: number;
  wind: number;
  radius: number;
  boom: number;
  groundBearing: number;
  siteHandover: boolean;
  status: LiftStep['status'];
  note: string;
}>({
  time: '07:30', loadRate: 0, clearance: 0, wind: 0, radius: 0, boom: 0,
  groundBearing: 0, siteHandover: false, status: 'pending', note: ''
});

function loadBufferFromStep() {
  const step = store.selectedStep;
  buffer.time = step.time;
  buffer.loadRate = step.loadRate;
  buffer.clearance = step.clearance;
  buffer.wind = step.wind;
  buffer.radius = step.radius;
  buffer.boom = step.boom;
  buffer.groundBearing = step.groundBearing;
  buffer.siteHandover = step.siteHandover;
  buffer.status = step.status;
  buffer.note = step.note;
}

// 切换步骤：从已提交快照重载
watch(() => store.selectedStepId, () => loadBufferFromStep(), { immediate: true });
// 外部窗口提交导致 revision 变化时，仅在本地无未提交编辑时重载；有编辑则保留，提交时由 CAS 判定
watch(() => store.doc.revision, () => {
  if (!dirty.value) loadBufferFromStep();
});

const dirty = computed(() => Object.keys(bufferPatch()).length > 0);

watch(
  buffer,
  () => {
    // 每次按键都留存窗口草稿，浏览器崩溃重开可恢复；无改动时清除
    if (dirty.value) store.stashDraft({ ...buffer });
    else store.clearStash();
  },
  { deep: true }
);

function bufferPatch(): Partial<LiftStep> {
  const step = store.selectedStep;
  const patch: Partial<LiftStep> = {};
  (Object.keys(buffer) as (keyof typeof buffer)[]).forEach((key) => {
    if (buffer[key] !== step[key]) {
      // @ts-expect-error 动态键同属 LiftStep 字段
      patch[key] = buffer[key];
    }
  });
  return patch;
}

function saveBuffer() {
  const patch = bufferPatch();
  if (Object.keys(patch).length === 0) {
    showToast('没有需要提交的修改', 'warn');
    return;
  }
  const result = store.updateStep(store.selectedStepId, patch, store.activeRole);
  report(result, `修改已提交（V${result.ok ? result.revision : ''}）`);
}

const FIELD_ROLE: Record<StepField, RoleId> = {
  time: 'general', siteHandover: 'general', status: 'general', note: 'general',
  radius: 'equipment', boom: 'equipment', groundBearing: 'equipment',
  clearance: 'safety', wind: 'safety',
  loadRate: 'planner'
};

function fieldOwnerClass(field: StepField): string {
  return FIELD_ROLE[field] === store.activeRole ? 'mine' : 'other';
}
function fieldOwnerLabel(field: StepField): string {
  return ROLE_MAP[FIELD_ROLE[field]].name;
}

function moveStep(stepId: string, delta: -1 | 1) {
  report(store.moveStep(stepId, delta), '步骤顺序已调整，全部角色需重新会签');
}

// ---------- 评论 ----------
function submitComment() {
  if (!commentText.value.trim()) return;
  const result = store.addComment(commentText.value, store.activeRole);
  if (result.ok) {
    commentText.value = '';
    showToast('意见已提交');
  } else {
    showToast(result.message ?? '提交失败', result.kind === 'conflict-queued' ? 'warn' : 'err');
  }
}

// ---------- 会签 ----------
type SigView =
  | { state: 'missing' }
  | { state: 'valid'; signedAt: string; revision: number; snapshotId: string }
  | { state: 'invalid'; signedAt: string; revision: number; snapshotId: string; reasons: string[] };

function sigView(role: RoleId): SigView {
  const sig = store.signatureByRole[role];
  if (!sig) return { state: 'missing' };
  const reasons = signatureInvalidReasons(sig, store.doc);
  if (reasons.length === 0) return { state: 'valid', signedAt: sig.signedAt, revision: sig.revision, snapshotId: sig.snapshotId };
  return { state: 'invalid', signedAt: sig.signedAt, revision: sig.revision, snapshotId: sig.snapshotId, reasons };
}

function signAs(role: RoleId) {
  report(store.sign(role), `${ROLE_MAP[role].name} 已在快照 ${store.currentSnapshotId} 上完成会签`);
}

// ---------- 发布 ----------
function publish() {
  const result = store.publish(store.activeRole);
  if (result.ok) showToast(`已原子发布新版本 V${result.revision}`);
  else showToast(result.message ?? '发布被门禁阻止', 'err');
}

// ---------- 冲突复核 ----------
function abandon(id: string) {
  report(store.abandonConflict(id), '该并发修改已放弃');
}
function reapply(id: string) {
  report(store.reapplyConflict(id, store.activeRole), '复核通过，已基于最新快照重新套用');
}

const conflictKindLabel: Record<string, string> = {
  edit: '参数修改', reorder: '顺序调整', sign: '会签', comment: '意见', resolve: '关闭意见'
};

// ---------- 崩溃恢复 ----------
function recoverDraft(index: number) {
  const draft = store.recoveredDrafts[index];
  if (!draft) return;
  store.selectStep(draft.stepId);
  if (draft.patch) Object.assign(buffer, draft.patch);
  if (draft.commentDraft) commentText.value = draft.commentDraft;
  
  store.dismissRecoveredDraft(draft.windowId);
  showToast('已恢复崩溃前未提交的编辑，请核对后提交');
}
function discardDraft(index: number) {
  const draft = store.recoveredDrafts[index];
  if (draft) store.dismissRecoveredDraft(draft.windowId);
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

function severityLabel(severity: string) {
  return severity === 'high' ? '阻断' : '预警';
}

function go(path: string) {
  router.push(path);
}

// ---------- 三维场景 ----------
function initializeScene() {
  if (!canvasRef.value || !sceneContainer.value) return;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#dce6e1');
  scene.fog = new THREE.Fog('#dce6e1', 34, 78);

  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 160);
  renderer = new THREE.WebGLRenderer({ canvas: canvasRef.value, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  scene.add(new THREE.HemisphereLight('#eefaf5', '#273b34', 2.3));
  const sun = new THREE.DirectionalLight('#fff4d6', 3.2);
  sun.position.set(14, 28, 18);
  scene.add(sun);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 44),
    new THREE.MeshStandardMaterial({ color: '#b8c7bf', roughness: 0.95 })
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  const grid = new THREE.GridHelper(60, 30, '#80948a', '#a8b8b0');
  grid.position.y = 0.02;
  scene.add(grid);

  const steel = new THREE.MeshStandardMaterial({ color: '#ec7a3c', roughness: 0.48, metalness: 0.35 });
  const darkSteel = new THREE.MeshStandardMaterial({ color: '#2d5c4f', roughness: 0.58, metalness: 0.42 });
  const truss = new THREE.Group();
  const chordGeometry = new THREE.BoxGeometry(18, 1.1, 1.1);
  for (const z of [-3.5, 3.5]) {
    for (const y of [4.2, 8.4]) {
      const chord = new THREE.Mesh(chordGeometry, steel);
      chord.position.set(0, y, z);
      truss.add(chord);
    }
  }
  for (let x = -8; x <= 8; x += 2) {
    const brace = new THREE.Mesh(new THREE.BoxGeometry(0.34, 4.8, 0.34), steel);
    brace.position.set(x, 6.2, -3.5);
    brace.rotation.z = x % 4 === 0 ? 0.36 : -0.36;
    truss.add(brace);
    const cross = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 7), darkSteel);
    cross.position.set(x, 4.2, 0);
    truss.add(cross);
  }
  truss.position.set(0, 6.5, 2);
  scene.add(truss);

  const crane = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(7, 1.2, 5), darkSteel);
  base.position.y = 0.6;
  crane.add(base);
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(3, 2.7, 3), new THREE.MeshStandardMaterial({ color: '#d8a733' }));
  cabin.position.set(-1, 2.5, 0);
  crane.add(cabin);
  const mast = new THREE.Mesh(new THREE.BoxGeometry(1.2, 24, 1.2), darkSteel);
  mast.position.y = 12;
  crane.add(mast);
  const boom = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 36), steel);
  boom.position.set(-8.5, 20.5, 9.5);
  boom.rotation.set(-0.38, 0.7, 0.14);
  crane.add(boom);
  crane.position.set(-15, 0, -12);
  scene.add(crane);

  const obstacleMat = new THREE.MeshStandardMaterial({ color: '#d34c45', transparent: true, opacity: 0.38 });
  const obstacle = new THREE.Mesh(new THREE.BoxGeometry(5, 5, 4), obstacleMat);
  obstacle.position.set(10, 2.5, 8);
  scene.add(obstacle);
  scene.add(new THREE.BoxHelper(obstacle, '#a92d2a'));

  const updateCamera = () => {
    const radius = 48;
    camera.position.set(
      Math.sin(theta) * Math.sin(phi) * radius,
      Math.cos(phi) * radius + 12,
      Math.cos(theta) * Math.sin(phi) * radius
    );
    camera.lookAt(0, 7, 0);
  };

  const render = () => {
    frame = requestAnimationFrame(render);
    truss.position.y = 6.5 + Math.sin(Date.now() / 900) * 0.08;
    updateCamera();
    renderer?.render(scene, camera);
  };
  render();

  const resize = () => {
    if (!sceneContainer.value || !renderer) return;
    const { width, height } = sceneContainer.value.getBoundingClientRect();
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(height, 1);
    camera.updateProjectionMatrix();
  };
  resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(sceneContainer.value);
  resize();

  canvasRef.value.onpointerdown = (event) => {
    dragging = true;
    previousX = event.clientX;
    canvasRef.value?.setPointerCapture(event.pointerId);
  };
  canvasRef.value.onpointermove = (event) => {
    if (!dragging) return;
    theta += (event.clientX - previousX) * 0.006;
    previousX = event.clientX;
  };
  canvasRef.value.onpointerup = () => {
    dragging = false;
  };
}

onMounted(() => {
  store.init();
  nextTick(initializeScene);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(frame);
  resizeObserver?.disconnect();
  renderer?.dispose();
});
</script>

<template>
  <q-layout view="hHh Lpr lFf" class="app-shell">
    <q-header elevated class="topbar">
      <q-toolbar>
        <div class="brand-mark">LIFT</div>
        <div class="brand-copy">
          <strong>大型构件吊装三维校核</strong>
          <span>{{ store.doc.name }} · 工作版本 V{{ store.doc.revision }} · 快照 {{ store.currentSnapshotId }}</span>
        </div>
        <q-space />
        <q-badge :color="store.locked ? 'teal' : 'orange'" outline class="status-badge">
          {{ store.locked ? '快照已发布锁定' : '会签中' }}
        </q-badge>
        <q-btn dense flat round icon="notifications" aria-label="通知">
          <q-badge floating color="red">{{ store.openComments.length }}</q-badge>
        </q-btn>
        <q-select
          :model-value="store.activeRole"
          dense
          outlined
          dark
          options-dense
          emit-value
          map-options
          class="role-select"
          :options="ROLES.map((r) => ({ value: r.id, label: `${r.name} · ${r.team}` }))"
          @update:model-value="(v: RoleId) => store.setActiveRole(v)"
        />
      </q-toolbar>
    </q-header>

    <q-drawer show-if-above side="left" :width="232" bordered class="left-nav">
      <div class="drawer-section-label">方案工作区</div>
      <q-list padding>
        <q-item
          v-for="item in nav"
          :key="item.path"
          clickable
          :active="route.path === item.path"
          active-class="nav-active"
          @click="go(item.path)"
        >
          <q-item-section avatar><q-icon :name="item.icon" /></q-item-section>
          <q-item-section>{{ item.label }}</q-item-section>
          <q-item-section v-if="item.path === '/checks'" side>
            <q-badge :color="store.pendingConflicts.length ? 'deep-orange' : 'negative'">
              {{ store.conflicts.length }}<span v-if="store.pendingConflicts.length">/{{ store.pendingConflicts.length }}</span>
            </q-badge>
          </q-item-section>
        </q-item>
      </q-list>
      <div class="draft-state">
        <q-icon name="cloud_done" color="teal" />
        <span>
          参数快照双写持久化<br />
          <small>窗口 {{ store.windowId.slice(-5) }} · {{ store.lastCommitAt ? fmtTime(store.lastCommitAt) : '等待提交' }}</small>
        </span>
      </div>
    </q-drawer>

    <transition name="toast">
      <div v-if="toast" class="app-toast" :class="toast.tone">
        <q-icon :name="toast.tone === 'ok' ? 'check_circle' : toast.tone === 'warn' ? 'warning' : 'error'" />
        <span>{{ toast.text }}</span>
      </div>
    </transition>

    <q-page-container>
      <q-page class="workspace-page">
        <!-- 崩溃恢复条 -->
        <div v-if="store.recoveredDrafts.length" class="recovery-banner">
          <q-icon name="restore" size="22px" />
          <div>
            <strong>检测到 {{ store.recoveredDrafts.length }} 份浏览器崩溃/异常关闭前未提交的编辑草稿</strong>
            <span>参数快照已完整恢复；以下草稿可套用为当前编辑，核对后再提交。</span>
          </div>
          <q-space />
          <template v-for="(draft, index) in store.recoveredDrafts" :key="draft.windowId">
            <q-btn dense no-caps color="primary" :label="`恢复 ${draft.stepId} 草稿`" @click="recoverDraft(index)" class="recovery-btn" />
            <q-btn dense flat no-caps label="忽略" @click="discardDraft(index)" class="recovery-btn" />
          </template>
        </div>

        <header class="page-heading">
          <div>
            <div class="eyebrow">{{ store.doc.planId }} / {{ pageTitle }}</div>
            <h1>{{ pageTitle }}</h1>
          </div>
          <div class="heading-actions">
            <q-btn outline no-caps icon="ios_share" label="导出吊装指令" />
            <q-btn
              color="primary"
              no-caps
              icon="lock"
              :label="store.locked ? '当前快照已发布' : '会签发布'"
              :disable="!store.gate.canPublish"
              @click="publish"
            />
          </div>
        </header>

        <section v-if="route.path === '/' || route.path === '/models'" class="work-grid">
          <article class="scene-panel content-panel">
            <div class="panel-heading">
              <div>
                <span class="panel-kicker">THREE.JS SCENE · 绑定快照 {{ store.currentSnapshotId }}</span>
                <h2>吊装姿态与空间冲突</h2>
              </div>
              <div class="view-bookmarks">
                <button
                  v-for="bookmark in viewBookmarks"
                  :key="bookmark"
                  :class="{ active: activeBookmark === bookmark }"
                  @click="setBookmark(bookmark)"
                >
                  {{ bookmark }}
                </button>
              </div>
            </div>
            <div ref="sceneContainer" class="scene-container">
              <canvas ref="canvasRef" aria-label="吊装三维场景" />
              <div class="scene-legend">
                <span><i class="legend-dot crane" />主吊</span>
                <span><i class="legend-dot load" />构件</span>
                <span><i class="legend-dot risk" />障碍物</span>
              </div>
              <div class="scene-hint">拖动旋转视角 · 参数修改先暂存，提交时走版本校验</div>
            </div>
            <div class="timeline">
              <div
                v-for="(step, index) in store.steps"
                :key="step.id"
                class="timeline-step"
                :class="[step.status, { selected: store.selectedStepId === step.id }]"
                @click="store.selectStep(step.id)"
              >
                <div class="timeline-reorder">
                  <q-btn dense flat round size="sm" icon="arrow_upward" :disable="index === 0" @click.stop="moveStep(step.id, -1)" />
                  <q-btn dense flat round size="sm" icon="arrow_downward" :disable="index === store.steps.length - 1" @click.stop="moveStep(step.id, 1)" />
                </div>
                <span>{{ step.time }}</span>
                <strong>{{ step.title }}</strong>
                <small>{{ step.loadRate }}% 荷载 · {{ step.clearance }}m 净空</small>
              </div>
            </div>
          </article>

          <aside class="inspector-panel content-panel">
            <div class="panel-heading compact">
              <div>
                <span class="panel-kicker">STEP INSPECTOR</span>
                <h2>{{ store.selectedStep.id }} · {{ store.selectedStep.title }}</h2>
              </div>
            </div>
            <div v-if="dirty" class="dirty-banner">
              有未提交修改 · 已暂存为窗口草稿（崩溃可恢复）
            </div>
            <div class="metric-grid">
              <div><span>荷载率 <i class="owner-tag" :class="fieldOwnerClass('loadRate')">{{ fieldOwnerLabel('loadRate') }}</i></span><strong :class="{ danger: buffer.loadRate > 90 }">{{ buffer.loadRate }}%</strong></div>
              <div><span>最小净空 <i class="owner-tag" :class="fieldOwnerClass('clearance')">{{ fieldOwnerLabel('clearance') }}</i></span><strong :class="{ danger: buffer.clearance < 1.5 }">{{ buffer.clearance }}m</strong></div>
              <div><span>作业半径 <i class="owner-tag" :class="fieldOwnerClass('radius')">{{ fieldOwnerLabel('radius') }}</i></span><strong>{{ buffer.radius }}m</strong></div>
              <div><span>风速限制 <i class="owner-tag" :class="fieldOwnerClass('wind')">{{ fieldOwnerLabel('wind') }}</i></span><strong :class="{ danger: buffer.wind > 8 }">{{ buffer.wind }}m/s</strong></div>
            </div>

            <div class="field-row">
              <label class="field-label">荷载率（方案工程职责）</label>
              <q-slider v-model="buffer.loadRate" :min="0" :max="120" color="primary" />
            </div>
            <div class="form-row">
              <div>
                <label class="field-label">最小净空 m（安全监督职责）</label>
                <q-input v-model.number="buffer.clearance" type="number" outlined dense />
              </div>
              <div>
                <label class="field-label">风速 m/s（安全监督职责）</label>
                <q-input v-model.number="buffer.wind" type="number" outlined dense />
              </div>
            </div>
            <div class="form-row">
              <div>
                <label class="field-label">作业半径 m（设备管理职责）</label>
                <q-input v-model.number="buffer.radius" type="number" outlined dense />
              </div>
              <div>
                <label class="field-label">臂长 m（设备管理职责）</label>
                <q-input v-model.number="buffer.boom" type="number" outlined dense />
              </div>
            </div>
            <div class="form-row">
              <div>
                <label class="field-label">作业时间（总包职责）</label>
                <q-input v-model="buffer.time" type="time" outlined dense />
              </div>
              <div>
                <label class="field-label">地耐力 kPa（设备管理职责）</label>
                <q-input v-model.number="buffer.groundBearing" type="number" outlined dense />
              </div>
            </div>
            <q-checkbox v-model="buffer.siteHandover" label="场地移交已确认（总包职责）" class="handover-check" />
            <label class="field-label">步骤结论（总包职责）</label>
            <q-btn-toggle
              v-model="buffer.status"
              spread
              no-caps
              toggle-color="primary"
              :options="[
                { label: '待复核', value: 'pending' },
                { label: '通过', value: 'passed' },
                { label: '阻断', value: 'blocked' }
              ]"
            />
            <q-input v-model="buffer.note" type="textarea" autogrow outlined label="现场控制说明（总包职责）" class="note-input" />
            <q-btn class="save-step" color="primary" no-caps icon="save" label="提交步骤修改（带版本校验）" @click="saveBuffer" />
            <p class="commit-hint">
              只有修改字段所属职责的签署会失效；其他角色签署保持有效。基于过期版本提交时不会覆盖先到结果，将留待复核。
            </p>
          </aside>
        </section>

        <section v-if="route.path === '/checks'" class="content-panel full-panel">
          <div class="panel-heading">
            <div>
              <span class="panel-kicker">RULE ENGINE + CONCURRENCY REVIEW</span>
              <h2>规则冲突、并发复核与条件清单</h2>
            </div>
            <q-badge color="negative">{{ store.conflicts.length }} 项规则冲突</q-badge>
          </div>

          <div v-if="store.pendingConflicts.length" class="conflict-queue">
            <div class="queue-head">
              <q-icon name="merge_type" color="deep-orange" />
              <strong>{{ store.pendingConflicts.length }} 份并发修改待复核</strong>
              <span>后提交未覆盖先到结果，请逐条放弃或基于最新快照重新套用。</span>
            </div>
            <div v-for="item in store.pendingConflicts" :key="item.id" class="queue-item">
              <div class="queue-main">
                <q-badge color="deep-orange">{{ conflictKindLabel[item.kind] }}</q-badge>
                <div>
                  <strong>{{ item.summary }}</strong>
                  <p>{{ item.detail }}</p>
                  <small>提交者 {{ item.author }} · 依据 V{{ item.baseRevision }}，先到结果 V{{ item.landedRevision }} · {{ fmtTime(item.createdAt) }}</small>
                </div>
              </div>
              <div class="queue-actions">
                <q-btn flat no-caps color="grey-8" label="放弃" @click="abandon(item.id)" />
                <q-btn unelevated no-caps color="primary" icon="playlist_add_check" label="复核后重新套用" @click="reapply(item.id)" />
              </div>
            </div>
          </div>

          <div class="check-layout">
            <div class="conflict-list">
              <button v-for="item in store.conflicts" :key="item.id" class="conflict-item" @click="store.selectStep(item.stepId)">
                <span class="severity" :class="item.severity">{{ severityLabel(item.severity) }}</span>
                <div><strong>{{ item.stepId }} · {{ item.title }}</strong><small>{{ item.message }}</small></div>
                <q-icon name="arrow_forward" />
              </button>
              <div v-if="store.conflicts.length === 0" class="empty-state">当前快照未发现规则冲突。</div>
            </div>
            <div class="comments-panel">
              <h3>条件与评论 · {{ store.selectedStep.id }}</h3>
              <div v-for="comment in store.comments.filter((c) => c.stepId === store.selectedStepId)" :key="comment.id" class="comment-row">
                <div class="comment-avatar">{{ comment.author.slice(0, 1) }}</div>
                <div>
                  <strong>{{ comment.author }} <small>{{ ROLE_MAP[comment.role].team }}</small></strong>
                  <p>{{ comment.content }}</p>
                  <button v-if="comment.status === 'open'" @click="report(store.resolveComment(comment.id, store.activeRole), '意见已关闭')">标记已解决</button>
                  <span v-else class="resolved">已解决</span>
                </div>
              </div>
              <q-input v-model="commentText" type="textarea" outlined autogrow label="对该步骤提出条件或补充意见" />
              <q-btn color="primary" no-caps icon="send" :label="`提交意见（${ROLE_MAP[store.activeRole].name}）`" @click="submitComment" />
            </div>
          </div>
        </section>

        <section v-if="route.path === '/review'" class="content-panel full-panel">
          <div class="panel-heading">
            <div>
              <span class="panel-kicker">MULTI-PARTY SIGN-OFF · 签署绑定快照 {{ store.currentSnapshotId }}</span>
              <h2>多角色会签与原子发布门禁</h2>
            </div>
            <div class="readiness"><strong>{{ store.readiness }}%</strong><span>发布就绪度</span></div>
          </div>

          <div class="gate-strip">
            <div :class="{ ok: store.gate.signedRoles.length === 4 }">
              <q-icon :name="store.gate.signedRoles.length === 4 ? 'verified' : 'pending_actions'" />
              签署有效 {{ store.gate.signedRoles.length }}/4
            </div>
            <div :class="{ ok: store.gate.ruleConflictCount === 0 }">
              <q-icon :name="store.gate.ruleConflictCount === 0 ? 'rule_folder' : 'warning'" />
              规则冲突 {{ store.gate.ruleConflictCount }}
            </div>
            <div :class="{ ok: store.gate.pendingConflictCount === 0 }">
              <q-icon :name="store.gate.pendingConflictCount === 0 ? 'merge' : 'merge_type'" />
              并发冲突 {{ store.gate.pendingConflictCount }}
            </div>
            <div :class="{ ok: store.gate.openCommentCount === 0 }">
              <q-icon :name="store.gate.openCommentCount === 0 ? 'mark_chat_read' : 'chat_bubble'" />
              未关闭意见 {{ store.gate.openCommentCount }}
            </div>
            <div :class="{ ok: !store.gate.alreadyPublished }">
              <q-icon :name="store.gate.alreadyPublished ? 'lock' : 'publish'" />
              {{ store.gate.alreadyPublished ? '快照已发布' : '快照未发布' }}
            </div>
          </div>

          <div class="review-grid">
            <article
              v-for="role in ROLES"
              :key="role.id"
              class="review-card"
              :class="{ self: role.id === store.activeRole, invalid: sigView(role.id).state === 'invalid', valid: sigView(role.id).state === 'valid' }"
            >
              <div class="review-head">
                <strong>{{ role.name }} <small v-if="role.id === store.activeRole">· 本窗口角色</small></strong>
                <q-badge v-if="sigView(role.id).state === 'valid'" color="positive">签署有效</q-badge>
                <q-badge v-else-if="sigView(role.id).state === 'invalid'" color="negative">签署已失效</q-badge>
                <q-badge v-else color="grey">待签署</q-badge>
              </div>
              <span>{{ role.team }}</span>
              <p>{{ role.scopeLabel }}</p>
              <ul class="scope-fields">
                <li v-for="f in role.fields" :key="f">{{ FIELD_LABELS[f] }}</li>
              </ul>

              <template v-if="sigView(role.id).state !== 'missing'">
                <div class="sig-meta">
                  签署于 V{{ (sigView(role.id) as any).revision }} · {{ fmtTime((sigView(role.id) as any).signedAt) }}
                  <small>签署快照 {{ (sigView(role.id) as any).snapshotId }}</small>
                </div>
                <ul v-if="sigView(role.id).state === 'invalid'" class="invalidate-reasons">
                  <li v-for="(reason, i) in (sigView(role.id) as any).reasons" :key="i">{{ reason }}</li>
                </ul>
              </template>

              <q-btn
                v-if="role.id === store.activeRole"
                unelevated
                no-caps
                :color="sigView(role.id).state === 'valid' ? 'positive' : 'primary'"
                :icon="sigView(role.id).state === 'valid' ? 'how_to_reg' : 'draw'"
                :label="sigView(role.id).state === 'missing' ? '签署确认本快照' : '在当前快照重新签署'"
                @click="signAs(role.id)"
              />
              <div v-else class="other-role-hint">切换为该角色所在窗口完成签署</div>
            </article>
          </div>

          <div v-if="store.publishError" class="publish-error">
            <q-icon name="error" /> {{ store.publishError }}
          </div>

          <div class="release-gate">
            <div>
              <q-icon name="verified_user" size="30px" />
              <div>
                <strong>发布前门禁（事务内原子复核）</strong>
                <span>四角色签署对当前快照全部有效、规则冲突 / 并发冲突 / 未关闭意见全部清零，且该快照尚未发布时，才一次性生成新版本；任一条件不满足则整笔回滚。</span>
              </div>
            </div>
            <q-btn
              color="primary"
              no-caps
              icon="lock"
              :label="store.locked ? '当前快照已发布' : `锁定并发布 V${store.doc.revision + 1}`"
              :disable="!store.gate.canPublish"
              @click="publish"
            />
          </div>

          <div class="version-log">
            <h3>已发布版本（不可变快照）</h3>
            <div v-if="store.versions.length === 0" class="empty-state">尚无发布版本。</div>
            <div v-for="version in [...store.versions].reverse()" :key="version.revision" class="version-row" :class="{ current: version.snapshotId === store.currentSnapshotId }">
              <q-icon :name="version.snapshotId === store.currentSnapshotId ? 'lock' : 'history'" />
              <div>
                <strong>V{{ version.revision }} · {{ version.snapshotId }}</strong>
                <span>{{ version.publisher }} 发布于 {{ fmtTime(version.publishedAt) }} · {{ version.signatures.length }} 份有效签署 · {{ version.steps.length }} 个步骤</span>
              </div>
              <q-badge v-if="version.snapshotId === store.currentSnapshotId" color="teal">对应当前工作快照</q-badge>
            </div>
          </div>
        </section>
      </q-page>
    </q-page-container>
  </q-layout>
</template>
