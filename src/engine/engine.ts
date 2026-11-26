import { fmtDateTime, fmtTime } from './format';
import {
  COUNTER_FULL_NAME,
  ROSTER_STRATEGY_LABEL,
  actualIntervals,
  attendanceAt,
  attendanceEndAt,
  availableAt,
  availableOver,
  blockIntervals,
  clampIntervals,
  counterById,
  counterSuspended,
  counterWindowContaining,
  coverageReport,
  coversRange,
  fmtSlot,
  gapsWithin,
  generateFixedCrossSkilled,
  generateShortShift,
  mergeIntervals,
  openAttendanceOf,
  overlaps,
  plannedIntervals,
  rosterConflicts,
  shiftEffectiveIntervals,
  shiftIssues,
  skillActiveAt,
  skillActiveOver,
  volunteerBusyOver,
  volunteerById,
  windowEndAt,
  fmtRange,
  availabilityEndAt,
} from './roster';
import { seedState } from './seed';
import type {
  Assignment,
  Attendance,
  Booking,
  BookingStatus,
  CmdCtx,
  CmdOutcome,
  Command,
  ContactTask,
  CounterId,
  Family,
  Handover,
  Interval,
  PendingConfirmation,
  PromiseStatus,
  ProtectionStrategy,
  Receipt,
  ReturnPromise,
  Role,
  Room,
  RosterPlan,
  ShelterState,
  Shift,
  Volunteer,
} from './types';

/** 本地模拟适配器的异步确认时延（真实毫秒） */
export const CHECKIN_DELAY_REAL_MS = 1200;
export const CHECKOUT_DELAY_REAL_MS = 1500;

/** 预约自动转为等待态的原因前缀（用于覆盖恢复时自动复原） */
export const AUTO_WAIT_PREFIX = '[自动] ';

export const ROLE_LABEL: Record<Role, string> = {
  receptionist: '接待员',
  duty: '楼层值班员',
  bed_manager: '床位管理员',
  coordinator: '排班协调员',
  volunteer: '志愿者',
};

export const FAMILY_STATUS_LABEL: Record<Family['status'], string> = {
  registered: '待安置',
  draft: '草稿分房',
  confirming: '入住确认中',
  checked_in: '在场在住',
  temp_leave: '暂离在外',
  checked_out: '已退住',
};

export const STRATEGY_LABEL: Record<ProtectionStrategy, string> = {
  keep_room: '原房原床保留',
  capacity: '容量保护（返所换房）',
};

export const PROMISE_STATUS_LABEL: Record<PromiseStatus, string> = {
  active: '有效',
  fulfilled: '已兑现',
  expired_contact: '已逾期·联系核实中',
  cancelled: '已取消',
};

const PERMS: Record<Command['type'], Role[] | 'any'> = {
  RegisterFamily: ['receptionist'],
  CreateDraft: ['receptionist'],
  CancelDraft: ['receptionist'],
  SubmitCheckIn: ['receptionist'],
  RegisterLeave: ['receptionist'],
  ConfirmReturn: ['receptionist'],
  ExtendPromise: ['duty'],
  SubmitCheckout: ['duty'],
  AddTaskNote: ['duty'],
  CloseRoom: ['bed_manager'],
  ReopenRoom: ['bed_manager'],
  AdvanceClock: 'any',
  ResetDemo: 'any',
  FinalizeDue: 'any',
  // 排班与开台
  RegisterVolunteer: ['coordinator'],
  AddVolunteerBlock: ['coordinator'],
  RevokeSkill: ['coordinator'],
  RestoreSkill: ['coordinator'],
  GenerateRoster: ['coordinator'],
  ManualAssignShift: ['coordinator'],
  CancelShift: ['coordinator'],
  OpenCounterWindow: ['coordinator'],
  SignIn: ['volunteer', 'coordinator'],
  SignOut: ['volunteer', 'coordinator'],
  RequestHandover: ['coordinator', 'volunteer'],
  ConfirmHandover: ['coordinator', 'volunteer'],
  CancelHandover: ['coordinator'],
  CreateBooking: ['receptionist', 'coordinator'],
  RescheduleBooking: ['receptionist', 'coordinator'],
  CancelBooking: ['receptionist', 'coordinator'],
  ServeBooking: ['receptionist', 'duty', 'volunteer'],
};

// ---------------------------------------------------------------------------
// 派生计算（纯函数，UI 与引擎共用同一口径）
// ---------------------------------------------------------------------------

export function familyById(state: ShelterState, id: string): Family {
  const f = state.families.find((x) => x.id === id);
  if (!f) throw new Error(`家庭不存在: ${id}`);
  return f;
}

export function roomById(state: ShelterState, id: string): Room {
  const r = state.rooms.find((x) => x.id === id);
  if (!r) throw new Error(`房间不存在: ${id}`);
  return r;
}

export interface RoomBuckets {
  capacity: number;
  /** 实际在场（已确认入住） */
  present: number;
  /** 入住确认中（已预占，未计入在场） */
  confirming: number;
  /** 保护中（有效返所承诺占用） */
  protected: number;
  /** 草稿占用（仅展示，不参与分配） */
  drafts: number;
  /** 可分配 = 容量 - 在场 - 确认中 - 保护中 */
  allocatable: number;
}

export function roomBuckets(state: ShelterState, roomId: string): RoomBuckets {
  const room = roomById(state, roomId);
  let present = 0;
  let confirming = 0;
  let protectedBeds = 0;
  let drafts = 0;
  for (const f of state.families) {
    if (f.status === 'checked_in' && f.currentRoomId === roomId) present += f.size;
  }
  for (const a of state.assignments) {
    if (a.roomId !== roomId) continue;
    if (a.status === 'confirming') confirming += a.beds;
    else if (a.status === 'draft_open') drafts += a.beds;
  }
  for (const p of state.promises) {
    if (p.roomId === roomId && (p.status === 'active' || p.status === 'expired_contact')) {
      protectedBeds += p.beds;
    }
  }
  const allocatable =
    room.status === 'open' ? Math.max(0, room.capacity - present - confirming - protectedBeds) : 0;
  return { capacity: room.capacity, present, confirming, protected: protectedBeds, drafts, allocatable };
}

/** 有效返所承诺（含逾期未归仍受保护的） */
export function activePromiseOf(state: ShelterState, familyId: string): ReturnPromise | undefined {
  return state.promises.find(
    (p) => p.familyId === familyId && (p.status === 'active' || p.status === 'expired_contact'),
  );
}

export function openDraftOf(state: ShelterState, familyId: string): Assignment | undefined {
  return state.assignments.find((a) => a.familyId === familyId && a.status === 'draft_open');
}

export function latestStaleDraftOf(state: ShelterState, familyId: string): Assignment | undefined {
  const list = state.assignments.filter((a) => a.familyId === familyId && a.status === 'draft_stale');
  return list.sort((a, b) => b.createdAt - a.createdAt)[0];
}

export function pendingOf(
  state: ShelterState,
  familyId: string,
  kind?: PendingConfirmation['kind'],
): PendingConfirmation | undefined {
  return state.pending.find((p) => p.familyId === familyId && (!kind || p.kind === kind));
}

export function openTaskOf(state: ShelterState, familyId: string): ContactTask | undefined {
  return state.contactTasks.find((t) => t.familyId === familyId && t.status === 'open');
}

/**
 * 房间资格核验：容量、整组不可拆、无障碍、共房同意须同时满足。
 * 返回问题列表，空数组表示可分配。extraProtected 用于关房重规划的模拟。
 */
export function eligibility(
  state: ShelterState,
  family: Family,
  room: Room,
  extraProtected?: Record<string, number>,
): string[] {
  const issues: string[] = [];
  if (room.status !== 'open') issues.push(`房间${room.name}已临时关闭`);
  if (family.size > room.capacity)
    issues.push(`整组${family.size}人超过${room.name}容量${room.capacity}床，家庭不可拆分`);
  if (family.needsAccessible && !room.accessible)
    issues.push(`需要无障碍设施，${room.name}为普通房`);
  const b = roomBuckets(state, room.id);
  const extra = extraProtected?.[room.id] ?? 0;
  const avail = room.capacity - b.present - b.confirming - b.protected - extra;
  if (family.size > avail)
    issues.push(
      `${room.name}可分配${Math.max(0, avail)}床 < ${family.size}人（在场${b.present}/确认中${b.confirming}/保护中${b.protected + extra}）`,
    );
  const others = new Set<string>();
  for (const f of state.families) {
    if (f.status === 'checked_in' && f.currentRoomId === room.id && f.id !== family.id) others.add(f.id);
  }
  for (const p of state.promises) {
    if (
      p.roomId === room.id &&
      (p.status === 'active' || p.status === 'expired_contact') &&
      p.familyId !== family.id
    )
      others.add(p.familyId);
  }
  for (const a of state.assignments) {
    if (a.roomId === room.id && a.status === 'confirming' && a.familyId !== family.id) others.add(a.familyId);
  }
  if (others.size > 0) {
    if (!family.coRoomConsent) issues.push(`家庭未同意共房，${room.name}内已有其他家庭或返所保护`);
    for (const oid of others) {
      const of = state.families.find((f) => f.id === oid);
      if (of && !of.coRoomConsent) issues.push(`${room.name}内「${of.name}」未同意共房`);
    }
  }
  return issues;
}

/** 候选房间列表：可分配的排前，其次无障碍匹配，再按可分配床数排序 */
export function suggestRooms(
  state: ShelterState,
  family: Family,
): { room: Room; issues: string[] }[] {
  return state.rooms
    .map((room) => ({ room, issues: eligibility(state, family, room) }))
    .sort((a, b) => {
      const ae = a.issues.length === 0 ? 0 : 1;
      const be = b.issues.length === 0 ? 0 : 1;
      if (ae !== be) return ae - be;
      const am = a.room.accessible === family.needsAccessible ? 0 : 1;
      const bm = b.room.accessible === family.needsAccessible ? 0 : 1;
      if (am !== bm) return am - bm;
      return roomBuckets(state, b.room.id).allocatable - roomBuckets(state, a.room.id).allocatable;
    });
}

/** 单条承诺当前是否仍能按家庭整组兑现 */
export function promiseIssues(state: ShelterState, p: ReturnPromise): string[] {
  const fam = familyById(state, p.familyId);
  const room = state.rooms.find((r) => r.id === p.roomId);
  if (!room) return ['保护房间不存在'];
  const issues: string[] = [];
  if (room.status !== 'open') issues.push(`保护房间${room.name}已临时关闭`);
  if (fam.needsAccessible && !room.accessible)
    issues.push(`${fam.name}需要无障碍设施，${room.name}不具备`);
  const others = new Set<string>();
  for (const f of state.families) {
    if (f.status === 'checked_in' && f.currentRoomId === room.id && f.id !== fam.id) others.add(f.id);
  }
  for (const q of state.promises) {
    if (q.id !== p.id && q.roomId === room.id && (q.status === 'active' || q.status === 'expired_contact'))
      others.add(q.familyId);
  }
  for (const a of state.assignments) {
    if (a.roomId === room.id && a.status === 'confirming' && a.familyId !== fam.id) others.add(a.familyId);
  }
  if (others.size > 0) {
    if (!fam.coRoomConsent) issues.push(`${fam.name}未同意共房`);
    for (const oid of others) {
      const of = state.families.find((f) => f.id === oid);
      if (of && !of.coRoomConsent) issues.push(`${room.name}内「${of.name}」未同意共房`);
    }
  }
  const b = roomBuckets(state, room.id);
  if (b.present + b.confirming + b.protected > room.capacity) issues.push(`${room.name}容量被突破`);
  return issues;
}

export interface InvariantResult {
  name: string;
  ok: boolean;
  detail: string;
}

/** 全所核对：家庭唯一位置、容量、承诺可兑现、人数口径一致、不自动搬动 */
export function checkInvariants(state: ShelterState): InvariantResult[] {
  const results: InvariantResult[] = [];

  const locBad: string[] = [];
  for (const f of state.families) {
    const activeAssign = state.assignments.filter(
      (a) => a.familyId === f.id && (a.status === 'active' || a.status === 'confirming'),
    );
    const activeProm = state.promises.filter(
      (p) => p.familyId === f.id && (p.status === 'active' || p.status === 'expired_contact'),
    );
    if (f.status === 'checked_in' && activeAssign.length !== 1)
      locBad.push(`${f.name}:在住但有效入住记录=${activeAssign.length}`);
    if (f.status === 'confirming' && activeAssign.length !== 1)
      locBad.push(`${f.name}:确认中但记录=${activeAssign.length}`);
    if (f.status === 'temp_leave' && activeProm.length !== 1)
      locBad.push(`${f.name}:暂离但有效承诺=${activeProm.length}`);
    if (f.status === 'temp_leave' && activeAssign.length > 0)
      locBad.push(`${f.name}:暂离却仍有入住记录`);
    if ((f.status === 'checked_in' || f.status === 'confirming') && activeProm.length > 0)
      locBad.push(`${f.name}:在场却仍有返所承诺`);
    if (
      (f.status === 'registered' || f.status === 'draft' || f.status === 'checked_out') &&
      (activeAssign.length > 0 || activeProm.length > 0)
    )
      locBad.push(`${f.name}:${FAMILY_STATUS_LABEL[f.status]}却仍有床位记录`);
  }
  results.push({
    name: '家庭唯一位置',
    ok: locBad.length === 0,
    detail: locBad.join('；') || '每个家庭在任一时刻只有一个确定位置（在住房间 / 暂离承诺 / 待安置）',
  });

  const capBad = state.rooms
    .map((r) => ({ r, b: roomBuckets(state, r.id) }))
    .filter((x) => x.b.present + x.b.confirming + x.b.protected > x.r.capacity)
    .map(
      (x) =>
        `${x.r.name}: 在场${x.b.present}+确认中${x.b.confirming}+保护${x.b.protected} > 容量${x.r.capacity}`,
    );
  results.push({
    name: '房间容量不被突破',
    ok: capBad.length === 0,
    detail: capBad.join('；') || '所有房间：在场 + 确认中 + 保护中 ≤ 容量',
  });

  const promBad: string[] = [];
  for (const p of state.promises) {
    if (p.status !== 'active' && p.status !== 'expired_contact') continue;
    const iss = promiseIssues(state, p);
    if (iss.length) promBad.push(`${familyById(state, p.familyId).name}: ${iss.join('、')}`);
  }
  results.push({
    name: '返所承诺可按家庭整组兑现',
    ok: promBad.length === 0,
    detail: promBad.join('；') || '全部有效承诺的保护容量完整、房间资格满足',
  });

  const byFam = state.families.filter((f) => f.status === 'checked_in').reduce((s, f) => s + f.size, 0);
  const byRoom = state.rooms.reduce((s, r) => s + roomBuckets(state, r.id).present, 0);
  results.push({
    name: '实际在场人数一致',
    ok: byFam === byRoom,
    detail: `家庭口径 ${byFam} 人 ＝ 房间口径 ${byRoom} 人`,
  });

  const moveBad = state.families
    .filter((f) => f.status === 'checked_in')
    .filter((f) => {
      const a = state.assignments.find((x) => x.familyId === f.id && x.status === 'active');
      return !a || a.roomId !== f.currentRoomId;
    })
    .map((f) => f.name);
  results.push({
    name: '已入住家庭未被自动搬动',
    ok: moveBad.length === 0,
    detail: moveBad.length ? `异常：${moveBad.join('、')}` : '在住家庭的入住记录与其房间一致，系统不做自动搬动',
  });

  // ---- 排班与开台核对 ----
  const multiCounter: string[] = [];
  for (const a of state.attendances.filter((x) => x.signedOutAt === undefined)) {
    const anyoneElse = state.attendances.find(
      (x) =>
        x.id !== a.id &&
        x.volunteerId === a.volunteerId &&
        x.counter !== a.counter &&
        x.signedOutAt === undefined,
    );
    if (anyoneElse) multiCounter.push(`${volunteerById(state, a.volunteerId)?.name ?? a.volunteerId} 同时在 A/B 在岗`);
  }
  results.push({
    name: '一人不同时支撑两个柜台',
    ok: multiCounter.length === 0,
    detail: multiCounter.join('；') || '所有在岗出勤均为单一柜台；联动换岗通过离岗+签到完成',
  });

  const planBad: string[] = [];
  for (const c of state.counters) {
    for (const w of c.windows) {
      const gaps = gapsWithin(plannedIntervals(state, c.id), w.start, w.end);
      if (gaps.length) planBad.push(`${c.name} 计划缺口 ${gaps.map(fmtRange).join('、')}`);
    }
  }
  results.push({
    name: '计划覆盖按实际时间区间检验',
    ok: planBad.length === 0,
    detail: planBad.join('；') || '两柜台每个开放窗口内均有计划班次区间衔接，无空窗（不按总工时相加）',
  });

  const conflictBad = rosterConflicts(state).map((c) => c.message);
  results.push({
    name: '班次无技能/时间冲突',
    ok: conflictBad.length === 0,
    detail: conflictBad.join('；') || '全部计划班次在技能有效、可用、无休息任务重叠、无跨柜台重叠的区间内',
  });

  const actualBad = coverageReport(state)
    .map((r) => {
      // 只核对“当前时刻”是否有人实际在岗；未来时段由计划覆盖与页面覆盖条展示
      const c = counterById(state, r.counter);
      const now = state.virtualNow;
      const inside = !!c && c.windows.some((w) => w.start <= now && now < w.end);
      if (!inside) return '';
      const covered = actualIntervals(state, r.counter).some((i) => i.start <= now && now < i.end);
      return covered ? '' : `${r.name} 当前时刻无实际签到在岗者`;
    })
    .filter(Boolean);
  results.push({
    name: '实际覆盖（当前时刻）',
    ok: actualBad.length === 0,
    detail: actualBad.join('；') || '两柜台当前时刻均有实际签到在岗者',
  });

  const pendingMulti = state.handovers.filter((h) => h.status === 'pending').length;
  const dupPending = (['A', 'B'] as CounterId[]).filter(
    (c) => state.handovers.filter((h) => h.counter === c && h.status === 'pending').length > 1,
  );
  const dupEffective = state.handovers.filter(
    (h) =>
      h.status === 'effective' &&
      state.handovers.some(
        (o) =>
          o.id !== h.id &&
          o.status === 'effective' &&
          o.counter === h.counter &&
          o.effectiveAt === h.effectiveAt,
      ),
  );
  results.push({
    name: '交接唯一生效',
    ok: dupPending.length === 0 && dupEffective.length === 0,
    detail:
      dupPending.length || dupEffective.length
        ? `异常：${[...dupPending.map((c) => `${c} 柜台重复待确认`), ...dupEffective.map((h) => `交接 ${h.id} 重复生效`)].join('；')}`
        : pendingMulti
          ? `${pendingMulti} 份交接待确认；每柜台同时最多一份待确认，双方确认只形成一份生效交接`
          : '每柜台同时至多一份待确认交接；生效交接唯一',
  });

  return results;
}

// ---------------------------------------------------------------------------
// 命令处理（在调用方提供的 IndexedDB 事务内同步执行）
// ---------------------------------------------------------------------------

function uid(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `id-${Math.random().toString(36).slice(2)}`;
}

function clone(s: ShelterState): ShelterState {
  return structuredClone(s);
}

type ReceiptSink = (kind: string, summary: string, lines?: string[], extra?: Partial<Receipt>) => Receipt;

function addReceipt(
  state: ShelterState,
  kind: string,
  actor: string,
  summary: string,
  lines: string[] = [],
  extra?: Partial<Receipt>,
): Receipt {
  const seq = ++state.seqCounter;
  const r: Receipt = { seq, id: `R${seq}`, at: state.virtualNow, kind, actor, summary, lines, ...extra };
  state.receipts.push(r);
  if (state.receipts.length > 500) state.receipts.splice(0, state.receipts.length - 500);
  return r;
}

function summarize(state: ShelterState, cmd: Command): string {
  const famName = (id: string) => state.families.find((f) => f.id === id)?.name ?? id;
  const roomName = (id: string) => state.rooms.find((r) => r.id === id)?.name ?? id;
  switch (cmd.type) {
    case 'RegisterFamily':
      return `登记家庭「${cmd.input.name}」`;
    case 'CreateDraft':
      return `草稿分房 ${famName(cmd.familyId)} → ${roomName(cmd.roomId)}`;
    case 'CancelDraft':
      return '取消草稿';
    case 'SubmitCheckIn':
      return '提交入住确认';
    case 'RegisterLeave':
      return `暂离登记 ${famName(cmd.familyId)}`;
    case 'ConfirmReturn':
      return `返所确认 ${famName(cmd.familyId)}`;
    case 'ExtendPromise':
      return `承诺延期 ${famName(cmd.familyId)}`;
    case 'SubmitCheckout':
      return `核实退住 ${famName(cmd.familyId)}`;
    case 'AddTaskNote':
      return '联系任务备注';
    case 'CloseRoom':
      return `临时关闭房间 ${roomName(cmd.roomId)}`;
    case 'ReopenRoom':
      return `重开房间 ${roomName(cmd.roomId)}`;
    case 'AdvanceClock':
      return '推进演示时间';
    case 'ResetDemo':
      return '重置演示数据';
    case 'FinalizeDue':
      return '异步确认结算';
    case 'RegisterVolunteer':
      return `登记志愿者「${cmd.input.name}」`;
    case 'AddVolunteerBlock':
      return `登记${cmd.kind === 'rest' ? '休息' : '临时任务'}区间`;
    case 'RevokeSkill':
      return `撤销志愿者技能（${COUNTER_FULL_NAME[cmd.counter]}）`;
    case 'RestoreSkill':
      return `恢复志愿者技能（${COUNTER_FULL_NAME[cmd.counter]}）`;
    case 'GenerateRoster':
      return `生成班表（${ROSTER_STRATEGY_LABEL[cmd.strategy]}）`;
    case 'ManualAssignShift':
      return `手工排班 ${COUNTER_FULL_NAME[cmd.counter]}`;
    case 'CancelShift':
      return '取消班次';
    case 'OpenCounterWindow':
      return `开放柜台窗口（${COUNTER_FULL_NAME[cmd.counter]}）`;
    case 'SignIn':
      return `志愿者签到（${COUNTER_FULL_NAME[cmd.counter]}）`;
    case 'SignOut':
      return '志愿者离岗';
    case 'RequestHandover':
      return `发起交接（${COUNTER_FULL_NAME[cmd.counter]}）`;
    case 'ConfirmHandover':
      return `确认交接（${cmd.side === 'outgoing' ? '交班方' : '接班方'}）`;
    case 'CancelHandover':
      return '取消交接';
    case 'CreateBooking':
      return `开放预约（${COUNTER_FULL_NAME[cmd.counter]}）`;
    case 'RescheduleBooking':
      return '改约';
    case 'CancelBooking':
      return '取消预约';
    case 'ServeBooking':
      return '办理预约';
  }
}

export function applyCommand(prev: ShelterState, cmd: Command, ctx: CmdCtx): CmdOutcome {
  if (cmd.type === 'ResetDemo') {
    const fresh = seedState();
    const r = addReceipt(fresh, 'reset', ROLE_LABEL[ctx.role], '演示数据已重置为初始场景', []);
    return { state: fresh, receipts: [r], changed: true };
  }

  // 幂等：同一 commandId 只生效一次，重复提交返回重复回执
  const seen = prev.commandLog.find((e) => e.commandId === cmd.commandId);
  if (seen) {
    const state = clone(prev);
    const r = addReceipt(
      state,
      'duplicate_submission',
      ROLE_LABEL[ctx.role],
      `重复提交已幂等忽略：${seen.summary}`,
      [`原回执：${seen.receiptIds.join('、') || '（无）'}`, '同一 commandId 的命令只会生效一次，状态未发生变化'],
      { duplicateOf: seen.receiptIds[0] },
    );
    state.version++;
    return { state, receipts: [r], changed: true };
  }

  const state = clone(prev);
  const receipts: Receipt[] = [];
  const R: ReceiptSink = (kind, summary, lines = [], extra) => {
    const r = addReceipt(state, kind, ROLE_LABEL[ctx.role], summary, lines, extra);
    receipts.push(r);
    return r;
  };

  const error = dispatch(state, cmd, ctx, R);
  // 每次变更后重核所有有效草稿：失效草稿保留输入并说明冲突
  revalidateDrafts(state, R);
  // 覆盖/预约口径同步：名义班表不等实际在岗，覆盖中断的预约转入等待，恢复后复原
  syncBookings(state, R);

  const mutated = receipts.length > 0 || !!error;
  if (!mutated) return { state: prev, receipts: [], changed: false };

  state.version++;
  state.commandLog.push({
    commandId: cmd.commandId,
    at: state.virtualNow,
    ok: !error,
    summary: summarize(state, cmd),
    receiptIds: receipts.map((r) => r.id),
  });
  if (state.commandLog.length > 300) state.commandLog.splice(0, state.commandLog.length - 300);
  return { state, receipts, error, changed: true };
}

function dispatch(state: ShelterState, cmd: Command, ctx: CmdCtx, R: ReceiptSink): string | undefined {
  const perm = PERMS[cmd.type];
  if (perm !== 'any' && !perm.includes(ctx.role)) {
    return `当前角色（${ROLE_LABEL[ctx.role]}）无权执行此操作，需要：${perm.map((r) => ROLE_LABEL[r]).join('或')}`;
  }
  switch (cmd.type) {
    case 'RegisterFamily':
      return hRegisterFamily(state, cmd, R);
    case 'CreateDraft':
      return hCreateDraft(state, cmd, R);
    case 'CancelDraft':
      return hCancelDraft(state, cmd, R);
    case 'SubmitCheckIn':
      return hSubmitCheckIn(state, cmd, ctx, R);
    case 'RegisterLeave':
      return hRegisterLeave(state, cmd, R);
    case 'ConfirmReturn':
      return hConfirmReturn(state, cmd, R);
    case 'ExtendPromise':
      return hExtendPromise(state, cmd, R);
    case 'SubmitCheckout':
      return hSubmitCheckout(state, cmd, ctx, R);
    case 'AddTaskNote':
      return hAddTaskNote(state, cmd, R);
    case 'CloseRoom':
      return hCloseRoom(state, cmd, R);
    case 'ReopenRoom':
      return hReopenRoom(state, cmd, R);
    case 'AdvanceClock':
      return hAdvanceClock(state, cmd, R);
    case 'FinalizeDue':
      return hFinalizeDue(state, ctx, R);
    case 'RegisterVolunteer':
      return hRegisterVolunteer(state, cmd, R);
    case 'AddVolunteerBlock':
      return hAddVolunteerBlock(state, cmd, R);
    case 'RevokeSkill':
      return hRevokeSkill(state, cmd, R);
    case 'RestoreSkill':
      return hRestoreSkill(state, cmd, R);
    case 'GenerateRoster':
      return hGenerateRoster(state, cmd, R);
    case 'ManualAssignShift':
      return hManualAssignShift(state, cmd, R);
    case 'CancelShift':
      return hCancelShift(state, cmd, R);
    case 'OpenCounterWindow':
      return hOpenCounterWindow(state, cmd, R);
    case 'SignIn':
      return hSignIn(state, cmd, ctx, R, state.virtualNow);
    case 'SignOut':
      return hSignOut(state, cmd, ctx, R);
    case 'RequestHandover':
      return hRequestHandover(state, cmd, R);
    case 'ConfirmHandover':
      return hConfirmHandover(state, cmd, ctx, R);
    case 'CancelHandover':
      return hCancelHandover(state, cmd, R);
    case 'CreateBooking':
      return hCreateBooking(state, cmd, R);
    case 'RescheduleBooking':
      return hRescheduleBooking(state, cmd, R);
    case 'CancelBooking':
      return hCancelBooking(state, cmd, R);
    case 'ServeBooking':
      return hServeBooking(state, cmd, R);
    default:
      return '未知命令';
  }
}

// ---------------------------------------------------------------------------
// 各命令处理器：返回错误文案（可能已附带状态变更，如草稿失效标记），undefined 表示成功
// ---------------------------------------------------------------------------

function hRegisterFamily(
  state: ShelterState,
  cmd: Extract<Command, { type: 'RegisterFamily' }>,
  R: ReceiptSink,
): string | undefined {
  const { name, size, needsAccessible, coRoomConsent, consentRoomChange } = cmd.input;
  if (!name.trim()) return '家庭名称不能为空';
  if (!Number.isInteger(size) || size < 1 || size > 20) return '家庭人数须为 1-20 的整数';
  const fam: Family = {
    id: uid(),
    name: name.trim(),
    size,
    needsAccessible,
    coRoomConsent,
    consentRoomChange,
    status: 'registered',
  };
  state.families.push(fam);
  R('family_registered', `已登记：${fam.name}（${fam.size}人）`, [
    `无障碍需求：${needsAccessible ? '需要' : '不需要'}；共房：${coRoomConsent ? '同意' : '不同意'}；返所换房：${consentRoomChange ? '同意' : '不同意'}`,
    '家庭已加入待安置列表，可创建分房草稿（草稿不占正式床位）',
  ]);
  return undefined;
}

function hCreateDraft(
  state: ShelterState,
  cmd: Extract<Command, { type: 'CreateDraft' }>,
  R: ReceiptSink,
): string | undefined {
  const fam = familyById(state, cmd.familyId);
  if (fam.status !== 'registered')
    return `当前状态（${FAMILY_STATUS_LABEL[fam.status]}）不能创建分房草稿`;
  if (openDraftOf(state, fam.id)) return '该家庭已存在未处理的草稿';
  const room = roomById(state, cmd.roomId);
  const issues = eligibility(state, fam, room);
  if (issues.length) return `草稿未通过资格核验：${issues.join('；')}`;
  const a: Assignment = {
    id: uid(),
    familyId: fam.id,
    roomId: room.id,
    beds: fam.size,
    kind: 'draft',
    status: 'draft_open',
    createdAt: state.virtualNow,
  };
  state.assignments.push(a);
  fam.status = 'draft';
  R('draft_created', `草稿分房：${fam.name}（${fam.size}人）→ ${room.name}房`, [
    '草稿不占正式床位，现场入住确认后才计入实际在场人数',
  ]);
  return undefined;
}

function hCancelDraft(
  state: ShelterState,
  cmd: Extract<Command, { type: 'CancelDraft' }>,
  R: ReceiptSink,
): string | undefined {
  const a = state.assignments.find((x) => x.id === cmd.assignmentId);
  if (!a || (a.status !== 'draft_open' && a.status !== 'draft_stale')) return '草稿不存在或已不可取消';
  const fam = familyById(state, a.familyId);
  a.status = 'draft_cancelled';
  if (fam.status === 'draft') fam.status = 'registered';
  R('draft_cancelled', `草稿已取消：${fam.name}`, []);
  return undefined;
}

function hSubmitCheckIn(
  state: ShelterState,
  cmd: Extract<Command, { type: 'SubmitCheckIn' }>,
  ctx: CmdCtx,
  R: ReceiptSink,
): string | undefined {
  const a = state.assignments.find((x) => x.id === cmd.assignmentId);
  if (!a) return '草稿不存在';
  const fam = familyById(state, a.familyId);
  if (a.status === 'draft_stale')
    return `草稿已失效：${a.conflictReason ?? ''}。原输入已保留在失效草稿中，可修改后重新创建。`;
  if (a.status !== 'draft_open') return '该草稿当前状态不能提交入住确认';
  const room = roomById(state, a.roomId);
  // 提交时在事务内重新核对房间资格（并发下另一标签可能已先占床）
  const issues = eligibility(state, fam, room);
  if (issues.length) {
    a.status = 'draft_stale';
    a.conflictReason = issues.join('；');
    if (fam.status === 'draft') fam.status = 'registered';
    R('draft_stale', `草稿失效：${fam.name} → ${room.name}房`, [
      `冲突原因：${a.conflictReason}`,
      '草稿输入已保留，可在床位变化后重试或改房',
    ]);
    return `提交时事务重核未通过：${a.conflictReason}`;
  }
  a.status = 'confirming';
  fam.status = 'confirming';
  state.pending.push({
    id: uid(),
    kind: 'checkin',
    familyId: fam.id,
    assignmentId: a.id,
    submittedAtReal: ctx.realNow,
    resolveAtReal: ctx.realNow + CHECKIN_DELAY_REAL_MS,
    atVirtual: state.virtualNow,
    actor: ctx.role,
  });
  R(
    'checkin_submitted',
    `入住确认已提交：${fam.name}（${fam.size}人）→ ${room.name}房`,
    ['本地模拟适配器进行异步现场核实（约1秒），完成后才计入实际在场人数；确认中床位已预占'],
    { pending: true },
  );
  return undefined;
}

function hRegisterLeave(
  state: ShelterState,
  cmd: Extract<Command, { type: 'RegisterLeave' }>,
  R: ReceiptSink,
): string | undefined {
  const fam = familyById(state, cmd.familyId);
  if (fam.status !== 'checked_in') return '仅在场在住家庭可登记暂离';
  if (pendingOf(state, fam.id, 'checkout')) return '退住核实进行中，不能登记暂离';
  if (cmd.expectedReturnAt <= state.virtualNow) return '预计返所时间须晚于当前演示时间';
  const originRoom = roomById(state, fam.currentRoomId!);
  const endActive = (reason: string) => {
    const a = state.assignments.find((x) => x.familyId === fam.id && x.status === 'active');
    if (a) {
      a.status = 'ended';
      a.endedAt = state.virtualNow;
      a.endReason = reason;
    }
  };

  if (cmd.strategy === 'keep_room') {
    endActive('暂离（原房原床保留）');
    const p: ReturnPromise = {
      id: uid(),
      familyId: fam.id,
      strategy: 'keep_room',
      roomId: originRoom.id,
      originRoomId: originRoom.id,
      beds: fam.size,
      expectedReturnAt: cmd.expectedReturnAt,
      status: 'active',
      createdAt: state.virtualNow,
    };
    state.promises.push(p);
    fam.status = 'temp_leave';
    fam.currentRoomId = undefined;
    R('leave_registered', `暂离登记：${fam.name}（${fam.size}人）外出，预计 ${fmtTime(cmd.expectedReturnAt)} 返所`, [
      `原房${originRoom.name}原床保留 ${fam.size} 床（保护中，不参与分配）`,
      '实际在场人数已减少，但住宿关系未结束，返所权保持有效',
    ]);
    return undefined;
  }

  // 容量保护：家庭须事先同意返所换房
  if (!fam.consentRoomChange) return '该家庭未事先同意返所换房，不能采用容量保护策略';
  if (!cmd.protectionRoomId) return '请选择用于返所安排的保护房间';
  const proom = roomById(state, cmd.protectionRoomId);
  if (proom.id === originRoom.id) return '容量保护需选择不同房间；如需留在原房请选择「原房原床保留」';
  const issues = eligibility(state, fam, proom);
  if (issues.length) return `保护房间资格核验未通过：${issues.join('；')}`;
  endActive('暂离（容量保护，释放原房）');
  const p: ReturnPromise = {
    id: uid(),
    familyId: fam.id,
    strategy: 'capacity',
    roomId: proom.id,
    originRoomId: originRoom.id,
    beds: fam.size,
    expectedReturnAt: cmd.expectedReturnAt,
    status: 'active',
    createdAt: state.virtualNow,
  };
  state.promises.push(p);
  fam.status = 'temp_leave';
  fam.currentRoomId = undefined;
  R('leave_registered', `暂离登记：${fam.name}（${fam.size}人）外出，预计 ${fmtTime(cmd.expectedReturnAt)} 返所`, [
    `家庭已同意返所换房：原${originRoom.name}房床位已释放，已在${proom.name}房保护 ${fam.size} 床作为返所安排`,
    `返所时将安排至${proom.name}房，须向返所家庭说明新房`,
  ]);
  return undefined;
}

function hConfirmReturn(
  state: ShelterState,
  cmd: Extract<Command, { type: 'ConfirmReturn' }>,
  R: ReceiptSink,
): string | undefined {
  const fam = familyById(state, cmd.familyId);
  if (fam.status !== 'temp_leave') return '家庭不处于暂离状态';
  if (pendingOf(state, fam.id, 'checkout')) return '退住核实进行中，无法办理返所';
  const p = activePromiseOf(state, fam.id);
  if (!p) return '无有效返所承诺（可能已被核实退住）';
  const room = roomById(state, p.roomId);
  if (room.status !== 'open') return `保护房间${room.name}已临时关闭，请先由床位管理员重开或调整保护安排`;
  const origin = roomById(state, p.originRoomId);
  state.assignments.push({
    id: uid(),
    familyId: fam.id,
    roomId: room.id,
    beds: fam.size,
    kind: 'checkin',
    status: 'active',
    createdAt: state.virtualNow,
    confirmedAt: state.virtualNow,
  });
  fam.status = 'checked_in';
  fam.currentRoomId = room.id;
  p.status = 'fulfilled';
  p.fulfilledAt = state.virtualNow;
  const task = openTaskOf(state, fam.id);
  if (task) {
    task.status = 'resolved';
    task.resolution = '家庭已返所';
    task.resolvedAt = state.virtualNow;
  }
  const lines =
    p.strategy === 'capacity'
      ? [
          `返所换房说明：原${origin.name}房 → 现${room.name}房（家庭事先已同意返所换房），请向返所家庭说明新房位置`,
          `保护床位 ${p.beds} 床已转为实际在场`,
        ]
      : [`返回原房${room.name}原床 ${p.beds} 床，承诺已兑现`];
  R('return_confirmed', `返所确认：${fam.name}（${fam.size}人）已回到${room.name}房`, lines);
  return undefined;
}

function hExtendPromise(
  state: ShelterState,
  cmd: Extract<Command, { type: 'ExtendPromise' }>,
  R: ReceiptSink,
): string | undefined {
  const fam = familyById(state, cmd.familyId);
  const p = activePromiseOf(state, fam.id);
  if (!p) return '无有效返所承诺';
  if (cmd.newExpectedReturnAt <= state.virtualNow) return '新的预计返所时间须晚于当前演示时间';
  const wasExpired = p.status === 'expired_contact';
  p.expectedReturnAt = cmd.newExpectedReturnAt;
  p.status = 'active';
  const task = openTaskOf(state, fam.id);
  if (task) {
    task.status = 'resolved';
    task.resolution = `已延期至 ${fmtTime(cmd.newExpectedReturnAt)}`;
    task.resolvedAt = state.virtualNow;
  }
  R('promise_extended', `返所承诺已延期：${fam.name} → 预计 ${fmtTime(cmd.newExpectedReturnAt)} 返所`, [
    wasExpired ? '逾期联系任务已随之解决，床位继续保护' : '床位继续保护',
  ]);
  return undefined;
}

function hSubmitCheckout(
  state: ShelterState,
  cmd: Extract<Command, { type: 'SubmitCheckout' }>,
  ctx: CmdCtx,
  R: ReceiptSink,
): string | undefined {
  const fam = familyById(state, cmd.familyId);
  if (fam.status !== 'checked_in' && fam.status !== 'temp_leave')
    return '仅在住或暂离家庭可办理退住';
  if (pendingOf(state, fam.id, 'checkout')) return '退住核实已在进行中';
  if (pendingOf(state, fam.id, 'checkin')) return '入住确认进行中，无法同时退住';
  state.pending.push({
    id: uid(),
    kind: 'checkout',
    familyId: fam.id,
    submittedAtReal: ctx.realNow,
    resolveAtReal: ctx.realNow + CHECKOUT_DELAY_REAL_MS,
    atVirtual: state.virtualNow,
    actor: ctx.role,
  });
  R(
    'checkout_submitted',
    `退住核实已提交：${fam.name}`,
    ['楼层值班员核实中（本地模拟适配器异步确认）；核实完成后结束返所权并释放床位'],
    { pending: true },
  );
  return undefined;
}

function hAddTaskNote(
  state: ShelterState,
  cmd: Extract<Command, { type: 'AddTaskNote' }>,
  R: ReceiptSink,
): string | undefined {
  const t = state.contactTasks.find((x) => x.id === cmd.taskId);
  if (!t || t.status !== 'open') return '联系任务不存在或已解决';
  if (!cmd.note.trim()) return '备注不能为空';
  t.notes.push(`${fmtDateTime(state.virtualNow)} ${cmd.note.trim()}`);
  const fam = familyById(state, t.familyId);
  R('task_note', `联系任务备注：${fam.name}`, [cmd.note.trim()]);
  return undefined;
}

function hCloseRoom(
  state: ShelterState,
  cmd: Extract<Command, { type: 'CloseRoom' }>,
  R: ReceiptSink,
): string | undefined {
  const room = roomById(state, cmd.roomId);
  if (room.status === 'closed') return '房间已处于关闭状态';
  const present = state.families.filter((f) => f.status === 'checked_in' && f.currentRoomId === room.id);
  if (present.length)
    return `房间${room.name}尚有在场家庭（${present.map((f) => f.name).join('、')}），已入住家庭不得被自动搬走，无法关闭`;
  const confirming = state.assignments.filter((a) => a.roomId === room.id && a.status === 'confirming');
  if (confirming.length) return `房间${room.name}有入住确认进行中，无法关闭`;
  const keepPromises = state.promises.filter(
    (p) => p.roomId === room.id && (p.status === 'active' || p.status === 'expired_contact') && p.strategy === 'keep_room',
  );
  if (keepPromises.length)
    return `房间${room.name}存在「原房原床」返所承诺（${keepPromises
      .map((p) => familyById(state, p.familyId).name)
      .join('、')}），相关家庭未选择换房，关闭将无法兑现返所权`;

  // 容量保护承诺：尝试整组迁移到其他房间（保护可迁移，已入住家庭不可迁移）
  const capPromises = state.promises.filter(
    (p) => p.roomId === room.id && (p.status === 'active' || p.status === 'expired_contact') && p.strategy === 'capacity',
  );
  const extra: Record<string, number> = {};
  const moves: { p: ReturnPromise; to: Room }[] = [];
  for (const p of capPromises) {
    const fam = familyById(state, p.familyId);
    const candidates = state.rooms
      .filter((r) => r.id !== room.id && r.status === 'open')
      .map((r) => ({ r, issues: eligibility(state, fam, r, extra) }))
      .filter((x) => x.issues.length === 0)
      .sort((a, b) => roomBuckets(state, b.r.id).allocatable - roomBuckets(state, a.r.id).allocatable);
    if (!candidates.length)
      return `无法关闭：返所承诺无法整组兑现——${fam.name}需${p.beds}床${fam.needsAccessible ? '（需无障碍）' : ''}，其他房间均不满足；房间保持开放`;
    const to = candidates[0].r;
    extra[to.id] = (extra[to.id] ?? 0) + p.beds;
    moves.push({ p, to });
  }
  for (const m of moves) m.p.roomId = m.to.id;
  room.status = 'closed';
  room.closedReason = cmd.reason || '临时关闭';
  const lines: string[] = [];
  for (const m of moves)
    lines.push(
      `返所保护迁移：${familyById(state, m.p.familyId).name} ${m.p.beds}床 → ${m.to.name}房（返所时须向家庭说明新房）`,
    );
  for (const d of state.assignments.filter((a) => a.roomId === room.id && a.status === 'draft_open')) {
    d.status = 'draft_stale';
    d.conflictReason = `房间${room.name}已临时关闭`;
    const f = familyById(state, d.familyId);
    if (f.status === 'draft') f.status = 'registered';
    lines.push(`草稿失效：${f.name} → ${room.name}房（输入已保留）`);
  }
  R('room_closed', `房间${room.name}已临时关闭（${room.closedReason}）`, lines);
  return undefined;
}

function hReopenRoom(
  state: ShelterState,
  cmd: Extract<Command, { type: 'ReopenRoom' }>,
  R: ReceiptSink,
): string | undefined {
  const room = roomById(state, cmd.roomId);
  if (room.status !== 'closed') return '房间未处于关闭状态';
  room.status = 'open';
  room.closedReason = undefined;
  R('room_reopened', `房间${room.name}已重新开放`, ['返所保护不自动迁回，保持当前承诺安排']);
  return undefined;
}

function hAdvanceClock(
  state: ShelterState,
  cmd: Extract<Command, { type: 'AdvanceClock' }>,
  R: ReceiptSink,
): string | undefined {
  if (cmd.toVirtual <= state.virtualNow) return '演示时间只能向前推进';
  state.virtualNow = cmd.toVirtual;
  R('clock_advanced', `演示时间推进至 ${fmtDateTime(cmd.toVirtual)}`, []);
  // 到期未归：只产生联系核实任务，不自动认定退住，床位继续保护
  for (const p of state.promises.filter(
    (x) => x.status === 'active' && x.expectedReturnAt < state.virtualNow,
  )) {
    p.status = 'expired_contact';
    const fam = familyById(state, p.familyId);
    state.contactTasks.push({
      id: uid(),
      familyId: fam.id,
      promiseId: p.id,
      createdAt: state.virtualNow,
      status: 'open',
      notes: [],
    });
    R('promise_expired', `返所承诺到期未归：${fam.name}（约定 ${fmtTime(p.expectedReturnAt)} 返所）`, [
      '已生成联系核实任务；按规则不自动认定退住，床位继续保护，返所权保持有效',
    ]);
  }
  return undefined;
}

function hFinalizeDue(state: ShelterState, ctx: CmdCtx, R: ReceiptSink): string | undefined {
  const due = state.pending.filter((p) => p.resolveAtReal <= ctx.realNow);
  for (const p of due) {
    state.pending.splice(state.pending.indexOf(p), 1);
    if (p.kind === 'checkin') finalizeCheckin(state, p, R);
    else finalizeCheckout(state, p, R);
  }
  return undefined;
}

function finalizeCheckin(state: ShelterState, p: PendingConfirmation, R: ReceiptSink): void {
  const a = state.assignments.find((x) => x.id === p.assignmentId);
  if (!a || a.status !== 'confirming') return; // 多标签重复结算的幂等保护
  const fam = familyById(state, p.familyId);
  const room = roomById(state, a.roomId);
  if (room.status !== 'open') {
    a.status = 'draft_stale';
    a.conflictReason = `房间${room.name}已临时关闭`;
    fam.status = 'registered';
    R('checkin_failed', `入住确认失败：${fam.name} → ${room.name}房`, [
      `冲突原因：${a.conflictReason}`,
      '草稿输入已保留，可修改后重试',
    ]);
    return;
  }
  a.status = 'active';
  a.confirmedAt = state.virtualNow;
  fam.status = 'checked_in';
  fam.currentRoomId = room.id;
  R('checkin_confirmed', `现场入住确认完成：${fam.name}（${fam.size}人）入住${room.name}房`, [
    '已计入实际在场人数',
  ]);
}

function finalizeCheckout(state: ShelterState, p: PendingConfirmation, R: ReceiptSink): void {
  const fam = familyById(state, p.familyId);
  if (fam.status === 'checked_out') return; // 幂等保护
  const a = state.assignments.find((x) => x.familyId === fam.id && x.status === 'active');
  if (a) {
    a.status = 'ended';
    a.endedAt = state.virtualNow;
    a.endReason = '核实退住';
  }
  const prom = activePromiseOf(state, fam.id);
  if (prom) {
    prom.status = 'cancelled';
    prom.cancelledAt = state.virtualNow;
  }
  fam.status = 'checked_out';
  fam.currentRoomId = undefined;
  const task = openTaskOf(state, fam.id);
  if (task) {
    task.status = 'resolved';
    task.resolution = '已核实退住';
    task.resolvedAt = state.virtualNow;
  }
  R('checkout_confirmed', `退住核实完成：${fam.name}`, [
    '返所权已结束，占用/保护床位已释放，住宿关系终止',
  ]);
}

/** 每次变更后重核有效草稿：失效的标记冲突原因并保留输入 */
function revalidateDrafts(state: ShelterState, R: ReceiptSink): void {
  for (const a of state.assignments.filter((x) => x.status === 'draft_open')) {
    const fam = familyById(state, a.familyId);
    const room = roomById(state, a.roomId);
    const issues = eligibility(state, fam, room);
    if (issues.length) {
      a.status = 'draft_stale';
      a.conflictReason = issues.join('；');
      if (fam.status === 'draft') fam.status = 'registered';
      R('draft_stale', `草稿失效：${fam.name} → ${room.name}房`, [
        `冲突原因：${a.conflictReason}`,
        '草稿输入已保留，可修改后重试',
      ]);
    }
  }
}

// ---------------------------------------------------------------------------
// 柜台排班与开台：命令处理器
// ---------------------------------------------------------------------------

function hRegisterVolunteer(
  state: ShelterState,
  cmd: Extract<Command, { type: 'RegisterVolunteer' }>,
  R: ReceiptSink,
): string | undefined {
  const name = cmd.input.name.trim();
  if (!name) return '志愿者姓名不能为空';
  if (state.volunteers.some((v) => v.name === name)) return `志愿者「${name}」已存在`;
  const skills = [...new Set(cmd.input.skills)].filter((c): c is CounterId => c === 'A' || c === 'B');
  if (skills.length === 0) return '至少需要一项已核准岗位技能';
  const available = mergeIntervals(cmd.input.available);
  if (available.length === 0) return '请登记至少一个可用时间区间';
  const v: Volunteer = { id: uid(), name, skills, available };
  state.volunteers.push(v);
  R('volunteer_registered', `已登记志愿者：${name}`, [
    `已核准技能：${skills.map((c) => COUNTER_FULL_NAME[c]).join('、')}`,
    `可用时间：${available.map(fmtRange).join('、')}`,
    '可用时间只是排班前提；是否实际在岗以签到出勤为准',
  ]);
  return undefined;
}

function hAddVolunteerBlock(
  state: ShelterState,
  cmd: Extract<Command, { type: 'AddVolunteerBlock' }>,
  R: ReceiptSink,
): string | undefined {
  const v = volunteerById(state, cmd.volunteerId);
  if (!v) return '志愿者不存在';
  if (cmd.end <= cmd.start) return '区间结束须晚于开始';
  state.blocks.push({
    id: uid(),
    volunteerId: v.id,
    kind: cmd.kind,
    start: cmd.start,
    end: cmd.end,
    label: cmd.label.trim() || (cmd.kind === 'rest' ? '休息' : '临时任务'),
  });
  const affected = state.shifts
    .filter((s) => s.status === 'planned' && s.volunteerId === v.id && overlaps(s, { start: cmd.start, end: cmd.end }))
    .map((s) => `${COUNTER_FULL_NAME[s.counter]} ${fmtRange(s)}`);
  R('volunteer_block_added', `已登记${cmd.kind === 'rest' ? '休息' : '临时任务'}：${v.name} ${fmtRange(cmd)}`, [
    ...(affected.length ? [`受影响的计划班次：${affected.join('、')}（覆盖按区间扣除，需安排替班）`] : []),
    '该区间内不再计入计划覆盖，也不能签到支撑该柜台',
  ]);
  return undefined;
}

function hRevokeSkill(
  state: ShelterState,
  cmd: Extract<Command, { type: 'RevokeSkill' }>,
  R: ReceiptSink,
): string | undefined {
  const v = volunteerById(state, cmd.volunteerId);
  if (!v) return '志愿者不存在';
  if (!v.skills.includes(cmd.counter)) return `该志愿者本不具备${COUNTER_FULL_NAME[cmd.counter]}技能`;
  const at = cmd.at ?? state.virtualNow;
  if (state.skillRevocations.some((r) => r.volunteerId === v.id && r.counter === cmd.counter && r.to === undefined)) {
    return `该志愿者的${COUNTER_FULL_NAME[cmd.counter]}技能已处于撤销状态`;
  }
  state.skillRevocations.push({ id: uid(), volunteerId: v.id, counter: cmd.counter, from: at });
  const affected = state.shifts
    .filter(
      (s) => s.status === 'planned' && s.volunteerId === v.id && s.counter === cmd.counter && s.end > at,
    )
    .map((s) => `${fmtRange(s)}`);
  R('skill_revoked', `技能资格已撤销：${v.name} · ${COUNTER_FULL_NAME[cmd.counter]}（自 ${fmtDateTime(at)}）`, [
    ...(affected.length ? [`后续计划班次失去资格：${affected.join('、')}，需重新排班`] : []),
    '撤销不删除既有班次与出勤记录；覆盖按区间扣除，已发生的服务不回撤',
  ]);
  return undefined;
}

function hRestoreSkill(
  state: ShelterState,
  cmd: Extract<Command, { type: 'RestoreSkill' }>,
  R: ReceiptSink,
): string | undefined {
  const v = volunteerById(state, cmd.volunteerId);
  if (!v) return '志愿者不存在';
  const at = cmd.at ?? state.virtualNow;
  const open = state.skillRevocations.filter(
    (r) => r.volunteerId === v.id && r.counter === cmd.counter && r.to === undefined,
  );
  if (!open.length) return '该技能没有处于撤销状态';
  for (const r of open) r.to = at;
  R('skill_restored', `技能资格已恢复：${v.name} · ${COUNTER_FULL_NAME[cmd.counter]}（自 ${fmtDateTime(at)}）`, [
    '恢复仅对恢复时刻之后的时段生效，此前缺岗区间仍记为缺口',
  ]);
  return undefined;
}

function hGenerateRoster(
  state: ShelterState,
  cmd: Extract<Command, { type: 'GenerateRoster' }>,
  R: ReceiptSink,
): string | undefined {
  if (cmd.windowEnd <= cmd.windowStart) return '排班窗口结束须晚于开始';
  const counters = state.counters;
  for (const c of counters) {
    const covering = c.windows.some((w) => w.start <= cmd.windowStart && cmd.windowEnd <= w.end);
    if (!covering) return `排班窗口须落在柜台开放区间内（${c.name}）`;
  }
  const gen =
    cmd.strategy === 'fixed_crossskilled'
      ? generateFixedCrossSkilled(state, cmd.windowStart, cmd.windowEnd)
      : generateShortShift(state, cmd.windowStart, cmd.windowEnd);
  if (gen.error) return gen.error;
  if (gen.drafts.length === 0) return '未能生成任何班次';
  // 新方案替换同窗口内的旧计划班次（出勤记录不受影响）
  for (const s of state.shifts) {
    if (s.status === 'planned' && s.start < cmd.windowEnd && cmd.windowStart < s.end) s.status = 'cancelled';
  }
  const plan: RosterPlan = {
    id: uid(),
    strategy: cmd.strategy,
    windowStart: cmd.windowStart,
    windowEnd: cmd.windowEnd,
    createdAt: state.virtualNow,
    status: 'active',
  };
  state.plans.push(plan);
  const drafts = [...gen.drafts].sort((a, b) => a.start - b.start || (a.counter < b.counter ? -1 : 1));
  for (const d of drafts) {
    state.shifts.push({
      id: uid(),
      volunteerId: d.volunteerId,
      counter: d.counter,
      start: d.start,
      end: d.end,
      kind: d.kind,
      planId: plan.id,
      status: 'planned',
    });
  }
  const nameOf = (id: string) => volunteerById(state, id)?.name ?? id;
  const lines = drafts.map(
    (d) =>
      `${fmtRange(d)} ${COUNTER_FULL_NAME[d.counter]}：${nameOf(d.volunteerId)}（${d.kind === 'main' ? '主班' : '替休'}）`,
  );
  for (const n of gen.notes) lines.push(n);
  R(
    'roster_generated',
    `已生成班表：${ROSTER_STRATEGY_LABEL[cmd.strategy]}（${fmtRange({ start: cmd.windowStart, end: cmd.windowEnd })}）`,
    lines,
  );
  return undefined;
}

function hManualAssignShift(
  state: ShelterState,
  cmd: Extract<Command, { type: 'ManualAssignShift' }>,
  R: ReceiptSink,
): string | undefined {
  const v = volunteerById(state, cmd.volunteerId);
  if (!v) return '志愿者不存在';
  if (cmd.end <= cmd.start) return '班次结束须晚于开始';
  const counter = counterById(state, cmd.counter);
  if (!counter) return '柜台不存在';
  if (!counterWindowContaining(counter, cmd.start, cmd.end)) return '班次须落在柜台开放窗口内';
  if (!v.skills.includes(cmd.counter)) return `${v.name} 不具备${COUNTER_FULL_NAME[cmd.counter]}技能`;
  if (!availableOver(v, cmd.start, cmd.end)) return `${v.name} 的登记可用时间未覆盖该班次`;
  if (blockIntervals(state, v.id).some((b) => overlaps(b, { start: cmd.start, end: cmd.end }))) {
    return `${v.name} 在该时段有休息或临时任务，不能排班`;
  }
  const plan =
    state.plans.find(
      (p) => p.status === 'active' && p.windowStart <= cmd.start && cmd.end <= p.windowEnd,
    ) ??
    (() => {
      const p: RosterPlan = {
        id: uid(),
        strategy: 'manual',
        windowStart: cmd.start,
        windowEnd: cmd.end,
        createdAt: state.virtualNow,
        status: 'active',
      };
      state.plans.push(p);
      return p;
    })();
  const shift: Shift = {
    id: uid(),
    volunteerId: v.id,
    counter: cmd.counter,
    start: cmd.start,
    end: cmd.end,
    kind: 'main',
    planId: plan.id,
    status: 'planned',
  };
  state.shifts.push(shift);
  const issue = volunteerBusyOver(state, v.id, cmd.start, cmd.end, shift.id);
  const skillIssue = !skillActiveOver(state, v, cmd.counter, cmd.start, cmd.end);
  R('shift_assigned', `手工排班：${v.name} → ${COUNTER_FULL_NAME[cmd.counter]} ${fmtRange(cmd)}`, [
    ...(issue ? [`⚠ 冲突：${issue}`] : []),
    ...(skillIssue ? ['⚠ 冲突：该时段技能资格已撤销'] : []),
    '计划班次不等于实际在岗；需志愿者签到后才会计入实际覆盖',
  ]);
  return undefined;
}

function hCancelShift(
  state: ShelterState,
  cmd: Extract<Command, { type: 'CancelShift' }>,
  R: ReceiptSink,
): string | undefined {
  const s = state.shifts.find((x) => x.id === cmd.shiftId);
  if (!s || s.status !== 'planned') return '班次不存在或已取消';
  s.status = 'cancelled';
  const v = volunteerById(state, s.volunteerId);
  R('shift_cancelled', `已取消计划班次：${v?.name ?? s.volunteerId} · ${COUNTER_FULL_NAME[s.counter]} ${fmtRange(s)}`, [
    '实际出勤记录不受影响：已发生的服务保留，覆盖按出勤区间计算',
  ]);
  return undefined;
}

function hSignIn(
  state: ShelterState,
  cmd: Extract<Command, { type: 'SignIn' }>,
  ctx: CmdCtx,
  R: ReceiptSink,
  now: number,
): string | undefined {
  const v = volunteerById(state, cmd.volunteerId);
  if (!v) return '志愿者不存在';
  if (ctx.role === 'volunteer' && ctx.volunteerId && ctx.volunteerId !== v.id) return '志愿者只能为本人签到';
  const counter = counterById(state, cmd.counter);
  if (!counter) return '柜台不存在';
  const at = cmd.at ?? now;
  if (at < now - 5 * 60_000) return '签到时间早于当前时间过多，请检查';
  if (!skillActiveAt(state, v, cmd.counter, at)) return `${v.name} 在此刻不具备${COUNTER_FULL_NAME[cmd.counter]}有效技能`;
  if (openAttendanceOf(state, v.id)) return `${v.name} 已在岗（一人不能同时支撑两个柜台），请先办理离岗`;
  const inside = counter.windows.some((w) => w.start <= at && at < w.end);
  if (!inside) return `柜台当前不在开放时间内，不能签到`;
  const shift = state.shifts.find(
    (s) =>
      s.status === 'planned' &&
      s.volunteerId === v.id &&
      s.counter === cmd.counter &&
      s.start <= at &&
      at < s.end,
  );
  const plannedEndAt = shift
    ? shift.end
    : Math.min(
        availabilityEndAt(v, at) ?? counter.windows.find((w) => w.start <= at && at < w.end)!.end,
        windowEndAt(counter, at) ?? at,
      );
  const lateSignIn = !!shift && at > shift.start + 5 * 60_000;
  const a: Attendance = {
    id: uid(),
    volunteerId: v.id,
    counter: cmd.counter,
    signedInAt: at,
    plannedEndAt,
    shiftId: shift?.id,
    lateSignIn,
  };
  state.attendances.push(a);
  const otherFree = state.attendances.some(
    (x) => x.counter === cmd.counter && x.id !== a.id && x.signedInAt <= at && at < attendanceEndAt(state, x),
  );
  R(
    'sign_in',
    `签到：${v.name} → ${COUNTER_FULL_NAME[cmd.counter]}（${fmtTime(at)}）`,
    [
      shift
        ? `对应计划班次 ${fmtRange(shift)}${lateSignIn ? '；迟到签到，班次开始至签到时刻记为实际缺口' : ''}`
        : '无对应计划班次：按实际可用时间在岗，作为临时补位',
      otherFree ? '提示：该柜台此刻已有他人在岗（允许交接重叠，实际覆盖按并集计算）' : '实际覆盖自签到时刻开始',
    ],
  );
  return undefined;
}

function hSignOut(
  state: ShelterState,
  cmd: Extract<Command, { type: 'SignOut' }>,
  ctx: CmdCtx,
  R: ReceiptSink,
): string | undefined {
  const a = state.attendances.find((x) => x.id === cmd.attendanceId);
  if (!a) return '出勤记录不存在';
  if (a.signedOutAt !== undefined) return '该出勤已办理离岗';
  if (ctx.role === 'volunteer' && ctx.volunteerId && ctx.volunteerId !== a.volunteerId)
    return '志愿者只能为本人办理离岗';
  const v = volunteerById(state, a.volunteerId);
  const at = cmd.at;
  if (at < a.signedInAt) return '离岗时间不能早于签到时间';
  const lateReport = cmd.reportedAt !== undefined && cmd.reportedAt > at;
  a.signedOutAt = at;
  a.lateReport = lateReport;
  a.reportedAt = cmd.reportedAt;
  a.signOutNote = cmd.note;
  const suspended = counterSuspended(state, a.counter);
  const person = v?.name ?? a.volunteerId;
  const lines = [
    lateReport
      ? `离岗回执晚到：按实际离岗时间 ${fmtTime(at)} 修订缺岗区间（回执 ${fmtTime(cmd.reportedAt!)} 到达）`
      : `实际覆盖至 ${fmtTime(at)} 结束`,
    '已发生的服务不回撤：历史出勤与覆盖记录保留',
  ];
  if (suspended) lines.push(`⚠ ${COUNTER_FULL_NAME[a.counter]} 当前无人实际在岗，已暂停放号；请安排直接替补或联动换岗`);
  R('sign_out', `离岗：${person} 离开 ${COUNTER_FULL_NAME[a.counter]}（实际离岗 ${fmtTime(at)}）`, lines);
  return undefined;
}

function hRequestHandover(
  state: ShelterState,
  cmd: Extract<Command, { type: 'RequestHandover' }>,
  R: ReceiptSink,
): string | undefined {
  const to = volunteerById(state, cmd.toVolunteerId);
  if (!to) return '接班人不存在';
  const now = state.virtualNow;
  const current = attendanceAt(state, cmd.counter, now);
  const otherCounter: CounterId = cmd.counter === 'A' ? 'B' : 'A';
  let fill: Volunteer | undefined;
  if (cmd.linkedSwap) {
    if (current && current.volunteerId === to.id) return '接班人已在当前柜台';
    if (!openAttendanceOf(state, to.id, otherCounter))
      return `${to.name} 当前并未在${COUNTER_FULL_NAME[otherCounter]}在岗，不能联动换岗；请使用直接替补`;
  }  if (!to.skills.includes(cmd.counter)) return `${to.name} 不具备${COUNTER_FULL_NAME[cmd.counter]}技能`;
  if (!skillActiveAt(state, to, cmd.counter, now)) return `${to.name} 的${COUNTER_FULL_NAME[cmd.counter]}技能资格当前无效`;
  if (!availableAt(to, now)) return `${to.name} 当前不在登记可用时间内`;
  if (state.blocks.some((b) => b.volunteerId === to.id && b.start <= now && now < b.end))
    return `${to.name} 当前处于休息或临时任务中`;
  const busyElsewhere = openAttendanceOf(state, to.id);
  // 直接替补若调走另一柜台的在岗者，是允许的，但会在生效时结束原柜台出勤（原柜台转暂停放号）；
  // 如希望两处都有人，应改用联动换岗并指定补位者。
  if (busyElsewhere && busyElsewhere.counter === cmd.counter && !cmd.linkedSwap)
    return `${to.name} 已在${COUNTER_FULL_NAME[cmd.counter]}在岗`;
  if (cmd.linkedSwap) {
    if (!cmd.fillVolunteerId)
      return '联动换岗需同时指定原柜台的补位者，否则原柜台将无人；如不补位请使用直接替补';
    fill = volunteerById(state, cmd.fillVolunteerId);
    if (!fill) return '补位志愿者不存在';
    if (fill.id === to.id || (current && fill.id === current.volunteerId)) return '补位者不能是参与换岗的本人';
    if (!fill.skills.includes(otherCounter)) return `${fill.name} 不具备${COUNTER_FULL_NAME[otherCounter]}技能`;
    if (!skillActiveAt(state, fill, otherCounter, now)) return `${fill.name} 的补位技能资格当前无效`;
    if (!availableAt(fill, now)) return `${fill.name} 当前不在登记可用时间内`;
    if (state.blocks.some((b) => b.volunteerId === fill!.id && b.start <= now && now < b.end))
      return `${fill.name} 当前处于休息或临时任务中`;
    if (openAttendanceOf(state, fill.id)) return `${fill.name} 已在岗，不能同时支撑两个柜台`;
  }
  if (state.handovers.some((h) => h.counter === cmd.counter && h.status === 'pending'))
    return `${COUNTER_FULL_NAME[cmd.counter]} 已有待确认交接，请先完成或取消`;
  const h: Handover = {
    id: uid(),
    counter: cmd.counter,
    fromVolunteerId: current?.volunteerId,
    toVolunteerId: to.id,
    linkedSwap: cmd.linkedSwap,
    fillVolunteerId: fill?.id,
    requestedAt: now,
    status: 'pending',
    note: cmd.linkedSwap
      ? `联动换岗：${to.name} 从${COUNTER_FULL_NAME[otherCounter]}调守${COUNTER_FULL_NAME[cmd.counter]}，${fill!.name} 补位${COUNTER_FULL_NAME[otherCounter]}`
      : current
        ? '直接替补'
        : '柜台无人·直接替补',
  };
  state.handovers.push(h);
  const fromName = current ? volunteerById(state, current.volunteerId)?.name ?? current.volunteerId : '（无人）';
  R(
    'handover_requested',
    `已发起交接：${COUNTER_FULL_NAME[cmd.counter]} ${fromName} → ${to.name}（${h.note}）`,
    [
      '交接需交班方与接班方双方确认后才生效；生效前该柜台暂停放号',
      '已有预约转入等待，不继续报“可办理”',
    ],
  );
  return undefined;
}

function hConfirmHandover(
  state: ShelterState,
  cmd: Extract<Command, { type: 'ConfirmHandover' }>,
  ctx: CmdCtx,
  R: ReceiptSink,
): string | undefined {
  const h = state.handovers.find((x) => x.id === cmd.handoverId);
  if (!h) return '交接不存在';
  if (h.status === 'effective') return '该交接已生效（重复确认不会产生第二份交接）';
  if (h.status !== 'pending') return '该交接当前状态不能确认';
  if (
    ctx.role === 'volunteer' &&
    ctx.volunteerId &&
    ctx.volunteerId !== h.toVolunteerId &&
    ctx.volunteerId !== h.fromVolunteerId
  ) {
    return '志愿者只能确认与本人相关的交接';
  }
  const now = state.virtualNow;
  if (cmd.side === 'outgoing') {
    if (!h.fromVolunteerId) return '该柜台本就无人，无需交班方确认，请由接班方确认';
    if (h.outgoingConfirmedAt !== undefined) return '交班方已确认，等待接班方确认';
    h.outgoingConfirmedAt = now;
  } else {
    if (h.incomingConfirmedAt !== undefined) return '接班方已确认，等待交班方确认';
    h.incomingConfirmedAt = now;
  }
  const bothConfirmed =
    h.fromVolunteerId === undefined || (h.outgoingConfirmedAt !== undefined && h.incomingConfirmedAt !== undefined);
  if (!bothConfirmed) {
    R('handover_confirmed_side', `交接单方确认：${COUNTER_FULL_NAME[h.counter]}（${cmd.side === 'outgoing' ? '交班方' : '接班方'}）`, [
      '等待另一方确认；柜台在交接生效前保持暂停放号',
    ]);
    return undefined;
  }
  // 双方确认（或柜台本就无人交班）→ 交接生效（只会形成一份生效交接）
  const to = volunteerById(state, h.toVolunteerId)!;
  const endAtFor = (v: Volunteer, c: CounterId) =>
    Math.min(availabilityEndAt(v, now) ?? Infinity, windowEndAt(counterById(state, c)!, now) ?? now);
  let vacatedCounter: CounterId | undefined;
  const otherCounter: CounterId = h.counter === 'A' ? 'B' : 'A';
  if (h.linkedSwap) {
    // 联动换岗：接班人离开原柜台调守本柜台，补位者接手原柜台；原柜台在岗者同时离岗
    const incomingExisting = openAttendanceOf(state, to.id, otherCounter);
    if (!incomingExisting) return '联动换岗失败：接班人已不在原柜台在岗，请改为直接替补';
    const fill = h.fillVolunteerId ? volunteerById(state, h.fillVolunteerId) : undefined;
    if (!fill) return '联动换岗失败：缺少补位者';
    const outgoingHere = h.fromVolunteerId
      ? state.attendances.find((a) => a.volunteerId === h.fromVolunteerId && a.signedOutAt === undefined)
      : undefined;
    if (outgoingHere) {
      outgoingHere.signedOutAt = now;
      outgoingHere.signOutNote = outgoingHere.signOutNote ?? '联动换岗生效时离岗';
    }
    incomingExisting.signedOutAt = now;
    state.attendances.push({
      id: uid(),
      volunteerId: to.id,
      counter: h.counter,
      signedInAt: now,
      plannedEndAt: endAtFor(to, h.counter),
    });
    state.attendances.push({
      id: uid(),
      volunteerId: fill.id,
      counter: otherCounter,
      signedInAt: now,
      plannedEndAt: endAtFor(fill, otherCounter),
    });
  } else {
    const outgoing = h.fromVolunteerId
      ? state.attendances.find((a) => a.volunteerId === h.fromVolunteerId && a.signedOutAt === undefined)
      : undefined;
    if (outgoing) {
      outgoing.signedOutAt = now;
      outgoing.signOutNote = outgoing.signOutNote ?? '交接生效时离岗';
    }
    // 直接替补若把另一柜台的在岗者调来，该柜台随之暂停放号（一人不能同时支撑两处）
    const elsewhere = openAttendanceOf(state, to.id);
    if (elsewhere) {
      elsewhere.signedOutAt = now;
      elsewhere.signOutNote = elsewhere.signOutNote ?? '直接替补调岗离岗';
      vacatedCounter = elsewhere.counter;
    }
    state.attendances.push({
      id: uid(),
      volunteerId: to.id,
      counter: h.counter,
      signedInAt: now,
      plannedEndAt: endAtFor(to, h.counter),
    });
  }
  h.status = 'effective';
  h.effectiveAt = now;
  const fromName = h.fromVolunteerId ? volunteerById(state, h.fromVolunteerId)?.name ?? h.fromVolunteerId : '（无人）';
  R('handover_effective', `交接已生效：${COUNTER_FULL_NAME[h.counter]} ${fromName} → ${to.name}`, [
    h.linkedSwap
      ? `联动换岗完成：${to.name} 调守${COUNTER_FULL_NAME[h.counter]}，${volunteerById(state, h.fillVolunteerId!)?.name ?? '补位者'} 接手${COUNTER_FULL_NAME[otherCounter]}`
      : '直接替补完成：新人自此刻起实际在岗',
    ...(vacatedCounter
      ? [`⚠ ${to.name} 原在${COUNTER_FULL_NAME[vacatedCounter]}在岗，调岗后该柜台暂停放号，需另找替补`]
      : []),
    '柜台恢复放号；原处于等待的预约在覆盖恢复后自动复原',
  ]);
  return undefined;
}

function hCancelHandover(
  state: ShelterState,
  cmd: Extract<Command, { type: 'CancelHandover' }>,
  R: ReceiptSink,
): string | undefined {
  const h = state.handovers.find((x) => x.id === cmd.handoverId);
  if (!h) return '交接不存在';
  if (h.status !== 'pending') return '只能取消待确认的交接';
  h.status = 'cancelled';
  R('handover_cancelled', `交接已取消：${COUNTER_FULL_NAME[h.counter]}`, ['柜台放号状态按当前实际在岗重新计算']);
  return undefined;
}

function hCreateBooking(
  state: ShelterState,
  cmd: Extract<Command, { type: 'CreateBooking' }>,
  R: ReceiptSink,
): string | undefined {
  const counter = counterById(state, cmd.counter);
  if (!counter) return '柜台不存在';
  if (!cmd.residentRef.trim()) return '请填写居民编号或称谓';
  if (cmd.slotEnd <= cmd.slotStart) return '预约时段结束须晚于开始';
  if (!counterWindowContaining(counter, cmd.slotStart, cmd.slotEnd))
    return `预约时段须落在${COUNTER_FULL_NAME[cmd.counter]}开放窗口内`;
  const clash = state.bookings.find(
    (b) =>
      b.counter === cmd.counter &&
      (b.status === 'booked' || b.status === 'waiting') &&
      overlaps({ start: b.slotStart, end: b.slotEnd }, { start: cmd.slotStart, end: cmd.slotEnd }),
  );
  if (clash) return `该时段已有预约（${clash.residentRef}），不能重复放号`;
  // 放号前以“实际覆盖”检验：只有实际在岗者才能承接名额
  const covered = coversRange(actualIntervals(state, cmd.counter), cmd.slotStart, cmd.slotEnd);
  const suspended =
    state.handovers.some((h) => h.counter === cmd.counter && h.status === 'pending') ||
    counterSuspended(state, cmd.counter, cmd.slotStart);
  const b: Booking = {
    id: uid(),
    counter: cmd.counter,
    slotStart: cmd.slotStart,
    slotEnd: cmd.slotEnd,
    residentRef: cmd.residentRef.trim(),
    status: covered && !suspended ? 'booked' : 'waiting',
    waitingReason: covered && !suspended ? undefined : suspended ? '[自动] 柜台暂停放号（无实际在岗或待确认接班）' : '[自动] 时段无实际在岗者覆盖',
  };
  state.bookings.push(b);
  R(
    'booking_created',
    covered && !suspended
      ? `已放号预约：${COUNTER_FULL_NAME[cmd.counter]} ${fmtSlot(cmd)} · ${b.residentRef}`
      : `预约进入等待：${COUNTER_FULL_NAME[cmd.counter]} ${fmtSlot(cmd)} · ${b.residentRef}`,
    [
      covered && !suspended
        ? '该时段有实际签到在岗者覆盖，可办理'
        : `原因：${b.waitingReason}；名额不视为可办理，待覆盖恢复后自动复原`,
      '名义排班不算数：只有实际签到在岗才开放名额',
    ],
  );
  return undefined;
}

function hRescheduleBooking(
  state: ShelterState,
  cmd: Extract<Command, { type: 'RescheduleBooking' }>,
  R: ReceiptSink,
): string | undefined {
  const b = state.bookings.find((x) => x.id === cmd.bookingId);
  if (!b) return '预约不存在';
  if (b.status === 'served' || b.status === 'cancelled') return '该预约已结束，不能改约';
  const counter = counterById(state, b.counter);
  if (!counter) return '柜台不存在';
  if (cmd.slotEnd <= cmd.slotStart) return '改约时段结束须晚于开始';
  if (!counterWindowContaining(counter, cmd.slotStart, cmd.slotEnd))
    return `改约时段须落在${COUNTER_FULL_NAME[b.counter]}开放窗口内`;
  const clash = state.bookings.find(
    (x) =>
      x.id !== b.id &&
      x.counter === b.counter &&
      (x.status === 'booked' || x.status === 'waiting') &&
      overlaps({ start: x.slotStart, end: x.slotEnd }, { start: cmd.slotStart, end: cmd.slotEnd }),
  );
  if (clash) return `目标时段已有预约（${clash.residentRef}）`;
  const old = { start: b.slotStart, end: b.slotEnd };
  b.slotStart = cmd.slotStart;
  b.slotEnd = cmd.slotEnd;
  b.wasRescheduled = true;
  b.rescheduleNote = `已改约：${fmtRange(old)} → ${fmtSlot(cmd)}`;
  b.status = 'booked';
  b.waitingReason = undefined;
  R('booking_rescheduled', `已改约：${b.residentRef} · ${COUNTER_FULL_NAME[b.counter]} ${fmtSlot(cmd)}`, [
    `原时段 ${fmtRange(old)} 已释放`,
    '改约后状态按新时段的实际覆盖自动重算',
  ]);
  return undefined;
}

function hCancelBooking(
  state: ShelterState,
  cmd: Extract<Command, { type: 'CancelBooking' }>,
  R: ReceiptSink,
): string | undefined {
  const b = state.bookings.find((x) => x.id === cmd.bookingId);
  if (!b) return '预约不存在';
  if (b.status === 'served') return '已办理的预约不能取消';
  b.status = 'cancelled';
  R('booking_cancelled', `预约已取消：${COUNTER_FULL_NAME[b.counter]} ${fmtSlot(b)} · ${b.residentRef}`, []);
  return undefined;
}

function hServeBooking(
  state: ShelterState,
  cmd: Extract<Command, { type: 'ServeBooking' }>,
  R: ReceiptSink,
): string | undefined {
  const b = state.bookings.find((x) => x.id === cmd.bookingId);
  if (!b) return '预约不存在';
  if (b.status === 'served') return '该预约已办理';
  if (b.status === 'cancelled') return '该预约已取消';
  if (b.status === 'waiting') return `该预约处于等待（${(b.waitingReason ?? '').replace('[自动] ', '')}），不能按可办理处理；请先恢复覆盖或改约`;
  const now = state.virtualNow;
  if (now < b.slotStart) return '尚未到预约时段，不能提前办理';
  if (now >= b.slotEnd) return '预约时段已过，请改约或取消';
  const assignee = attendanceAt(state, b.counter, now);
  if (!assignee) return `当前${COUNTER_FULL_NAME[b.counter]}无实际在岗者，不能办理（名义排班不算在岗）`;
  if (counterSuspended(state, b.counter)) return `${COUNTER_FULL_NAME[b.counter]}正处于待确认接班/暂停放号状态，暂不能办理`;
  b.status = 'served';
  b.servedAt = now;
  b.servedBy = assignee.volunteerId;
  const name = volunteerById(state, assignee.volunteerId)?.name ?? assignee.volunteerId;
  R('booking_served', `预约已办理：${b.residentRef} · ${COUNTER_FULL_NAME[b.counter]}（${name} 在岗办理）`, []);
  return undefined;
}

// ---------------------------------------------------------------------------
// 预约状态与覆盖同步（每次变更后调用）
// ---------------------------------------------------------------------------

const AUTO_PREFIX = '[自动] ';

function setAutoStatus(b: Booking, status: BookingStatus, reason?: string) {
  // 仅在非人工终态上自动切换
  if (b.status === 'served' || b.status === 'cancelled') return;
  b.status = status;
  if (status === 'booked') {
    if (b.waitingReason?.startsWith(AUTO_PREFIX)) b.waitingReason = undefined;
  } else if (reason) {
    b.waitingReason = AUTO_PREFIX + reason;
  }
}

/**
 * 预约只认“实际覆盖”：当前/未来时段的覆盖中断 → 转入等待（带原因）；
 * 覆盖恢复且无待确认交接 → 自动复原为可办理。人工填写的等待原因不被自动覆盖。
 */
function syncBookings(state: ShelterState, R: ReceiptSink): void {
  const now = state.virtualNow;
  for (const b of state.bookings) {
    if (b.status === 'served' || b.status === 'cancelled') continue;
    if (b.slotEnd <= now) {
      // 过期未办理：不自动宣称已办理；标记等待/失效，交由人工改约
      if (b.status !== 'waiting') setAutoStatus(b, 'waiting', '时段已过且未办理，请改约或取消');
      continue;
    }
    const suspended = state.handovers.some((h) => h.counter === b.counter && h.status === 'pending');
    const covers = coversRange(actualIntervals(state, b.counter), b.slotStart, b.slotEnd);
    if (suspended) {
      if (b.status !== 'waiting' || !b.waitingReason?.includes('待确认接班')) {
        const prev = b.status;
        setAutoStatus(b, 'waiting', '柜台待确认接班，暂停放号');
        if (prev !== 'waiting') {
          R('booking_affected', `预约受影响：${COUNTER_FULL_NAME[b.counter]} ${fmtSlot(b)} · ${b.residentRef}`, [
            '柜台有待确认接班，暂停放号；该预约不再显示“可办理”，转为等待',
          ]);
        }
      }
    } else if (!covers) {
      if (b.status !== 'waiting' || !(b.waitingReason ?? '').startsWith(AUTO_PREFIX)) {
        const prev = b.status;
        setAutoStatus(b, 'waiting', '时段无实际在岗者覆盖');
        if (prev !== 'waiting') {
          R('booking_affected', `预约受影响：${COUNTER_FULL_NAME[b.counter]} ${fmtSlot(b)} · ${b.residentRef}`, [
            '该时段实际覆盖中断（名义排班不算在岗），预约转为等待，请安排替补或改约',
          ]);
        }
      }
    } else if (
      (b.status === 'waiting' || b.status === 'rescheduled') &&
      (b.waitingReason ?? '').startsWith(AUTO_PREFIX)
    ) {
      const wasReason = b.waitingReason;
      b.status = 'booked';
      b.waitingReason = undefined;
      R('booking_restored', `预约恢复可办理：${COUNTER_FULL_NAME[b.counter]} ${fmtSlot(b)} · ${b.residentRef}`, [
        `覆盖已恢复（原等待原因：${wasReason?.replace(AUTO_PREFIX, '') ?? '—'}）`,
      ]);
    }
  }
}

function hOpenCounterWindow(
  state: ShelterState,
  cmd: Extract<Command, { type: 'OpenCounterWindow' }>,
  R: ReceiptSink,
): string | undefined {
  const counter = counterById(state, cmd.counter);
  if (!counter) return '柜台不存在';
  if (cmd.end <= cmd.start) return '开放窗口结束须晚于开始';
  const clash = counter.windows.some((w) => overlaps(w, { start: cmd.start, end: cmd.end }));
  if (clash) return '该时段与已有开放窗口重叠';
  counter.windows.push({ start: cmd.start, end: cmd.end });
  counter.windows.sort((a, b) => a.start - b.start);
  R('counter_window_opened', `已开放柜台窗口：${COUNTER_FULL_NAME[cmd.counter]} ${fmtRange(cmd)}`, [
    '新窗口需重新排班并签到后才可放号；跨日窗口按绝对时间区间检验',
  ]);
  return undefined;
}
