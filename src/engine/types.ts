/** 领域模型类型定义：避难所入住与返所工作台 */

/** 操作角色：接待员 / 楼层值班员 / 床位管理员 / 排班协调员 / 志愿者 */
export type Role = 'receptionist' | 'duty' | 'bed_manager' | 'coordinator' | 'volunteer';

/** 家庭当前状态（唯一位置口径） */
export type FamilyStatus =
  | 'registered' // 已登记，待安置（无床位）
  | 'draft' // 已有分房草稿（草稿不占床位）
  | 'confirming' // 入住确认中（已预占，尚未计入实际在场）
  | 'checked_in' // 在场在住
  | 'temp_leave' // 暂离在外（持有有效返所承诺）
  | 'checked_out'; // 已退住

export type RoomStatus = 'open' | 'closed';

export type AssignmentStatus =
  | 'draft_open' // 草稿有效
  | 'draft_stale' // 草稿失效（保留输入与冲突原因）
  | 'draft_cancelled'
  | 'confirming' // 入住确认中
  | 'active' // 正式入住
  | 'ended';

export type PromiseStatus =
  | 'active' // 有效返所承诺
  | 'fulfilled' // 已兑现（家庭已返所）
  | 'expired_contact' // 到期未归，联系核实中（不自动退住）
  | 'cancelled'; // 已取消（核实退住，返所权结束）

/** 床位保护策略：原房原床保留 / 容量保护（事先同意返所换房） */
export type ProtectionStrategy = 'keep_room' | 'capacity';

export interface Room {
  id: string;
  name: string;
  capacity: number;
  accessible: boolean;
  status: RoomStatus;
  closedReason?: string;
}

export interface Family {
  id: string;
  name: string;
  size: number;
  needsAccessible: boolean;
  /** 是否同意与其他家庭共房 */
  coRoomConsent: boolean;
  /** 是否事先同意返所时换房（容量保护策略的前提） */
  consentRoomChange: boolean;
  status: FamilyStatus;
  /** 在场/确认中时所在房间 */
  currentRoomId?: string;
}

export interface Assignment {
  id: string;
  familyId: string;
  roomId: string;
  beds: number;
  kind: 'draft' | 'checkin';
  status: AssignmentStatus;
  createdAt: number;
  confirmedAt?: number;
  endedAt?: number;
  endReason?: string;
  /** 失效草稿的冲突说明（输入保留） */
  conflictReason?: string;
}

/** 返所承诺：暂离家庭的床位权利 */
export interface ReturnPromise {
  id: string;
  familyId: string;
  strategy: ProtectionStrategy;
  /** 保护床位所在房间（keep_room=原房；capacity=保护房） */
  roomId: string;
  /** 暂离前所在房间（用于返所换房说明） */
  originRoomId: string;
  beds: number;
  expectedReturnAt: number;
  status: PromiseStatus;
  createdAt: number;
  fulfilledAt?: number;
  cancelledAt?: number;
}

/** 承诺到期未归产生的联系核实任务（不自动退住） */
export interface ContactTask {
  id: string;
  familyId: string;
  promiseId: string;
  createdAt: number;
  status: 'open' | 'resolved';
  resolution?: string;
  resolvedAt?: number;
  notes: string[];
}

/** 操作回执（可推进工作流程） */
export interface Receipt {
  seq: number;
  id: string;
  at: number;
  kind: string;
  actor: string;
  summary: string;
  lines: string[];
  /** 异步确认类回执：已提交、待完成 */
  pending?: boolean;
  /** 重复提交被幂等忽略时，指向原回执 */
  duplicateOf?: string;
}

/** 本地模拟适配器的异步确认单 */
export interface PendingConfirmation {
  id: string;
  kind: 'checkin' | 'checkout';
  familyId: string;
  assignmentId?: string;
  submittedAtReal: number;
  resolveAtReal: number;
  atVirtual: number;
  actor: Role;
}

export interface CommandLogEntry {
  commandId: string;
  at: number;
  ok: boolean;
  summary: string;
  receiptIds: string[];
}

// ---------------------------------------------------------------------------
// 柜台排班与开台（本次新增领域）
// ---------------------------------------------------------------------------

/** 柜台：A 接待柜台 / B 物资柜台 */
export type CounterId = 'A' | 'B';

export interface Counter {
  id: CounterId;
  name: string;
  /** 开放窗口（可多个，支持跨日班次；绝对时间） */
  windows: Interval[];
}

export interface Interval {
  start: number;
  end: number;
}

/** 志愿者：已核准岗位技能、登记可用时间与休息/临时任务区间 */
export interface Volunteer {
  id: string;
  name: string;
  skills: CounterId[];
  /** 登记的可用时间窗（多个） */
  available: Interval[];
}

/** 技能资格撤销区间（from 起失效；to 为恢复时间，未恢复则持续失效） */
export interface SkillRevocation {
  id: string;
  volunteerId: string;
  counter: CounterId;
  from: number;
  to?: number;
}

/** 休息 / 临时任务：同一志愿者在区间内不可排班 */
export type BlockKind = 'rest' | 'task';

export interface VolunteerBlock {
  id: string;
  volunteerId: string;
  kind: BlockKind;
  start: number;
  end: number;
  label: string;
}

export type ShiftKind = 'main' | 'relief';

/** 计划班次：只描述“名义排班”，不等于实际在岗 */
export interface Shift {
  id: string;
  volunteerId: string;
  counter: CounterId;
  start: number;
  end: number;
  kind: ShiftKind;
  planId: string;
  status: 'planned' | 'cancelled';
}

export type RosterStrategy = 'fixed_crossskilled' | 'short_shift' | 'manual';

export interface RosterPlan {
  id: string;
  strategy: RosterStrategy;
  windowStart: number;
  windowEnd: number;
  createdAt: number;
  status: 'active' | 'cancelled';
}

/** 实际出勤：签到产生，离岗回执关闭；与班表调整相互独立 */
export interface Attendance {
  id: string;
  volunteerId: string;
  counter: CounterId;
  signedInAt: number;
  signedOutAt?: number;
  /** 计划结束时刻（班次结束 / 接班替岗预计结束），实际覆盖不会超过它 */
  plannedEndAt: number;
  /** 签到对应的计划班次（无班次的接班替岗为空） */
  shiftId?: string;
  /** 签到是否晚于班次开始 */
  lateSignIn?: boolean;
  /** 离岗回执是否晚到 */
  lateReport?: boolean;
  /** 离岗回执到达时间（真实业务时间的到达时刻，用于说明晚到） */
  reportedAt?: number;
  signOutNote?: string;
}

export type HandoverStatus = 'pending' | 'effective' | 'cancelled' | 'superseded';

/** 交接：双方确认后生效；生效前柜台暂停放号 */
export interface Handover {
  id: string;
  counter: CounterId;
  /** 交班人（离岗者）；空表示柜台已无人、安排直接替补 */
  fromVolunteerId?: string;
  toVolunteerId: string;
  /** 联动换岗：接班人原在另一柜台，同时由 fillVolunteerId 补入该柜台 */
  linkedSwap: boolean;
  /** 联动换岗时为原柜台安排的补位者 */
  fillVolunteerId?: string;
  requestedAt: number;
  status: HandoverStatus;
  outgoingConfirmedAt?: number;
  incomingConfirmedAt?: number;
  effectiveAt?: number;
  supersededBy?: string;
  note?: string;
}

export type BookingStatus = 'booked' | 'waiting' | 'rescheduled' | 'served' | 'cancelled';

/** 预约：只有在相应时段有“实际在岗且技能有效者”时才可放号/可办理 */
export interface Booking {
  id: string;
  counter: CounterId;
  slotStart: number;
  slotEnd: number;
  residentRef: string;
  status: BookingStatus;
  waitingReason?: string;
  /** 是否发生过改约（用于页面显示“改约”标签） */
  wasRescheduled?: boolean;
  /** 改约说明（如“15:10–15:30 → 15:30–15:50”） */
  rescheduleNote?: string;
  servedAt?: number;
  servedBy?: string;
}

export interface ShelterState {
  version: number;
  /** 演示用虚拟时钟（业务时间，如承诺到期的判定依据） */
  virtualNow: number;
  rooms: Room[];
  families: Family[];
  assignments: Assignment[];
  promises: ReturnPromise[];
  contactTasks: ContactTask[];
  receipts: Receipt[];
  pending: PendingConfirmation[];
  commandLog: CommandLogEntry[];
  seqCounter: number;
  // ---- 柜台排班与开台 ----
  counters: Counter[];
  volunteers: Volunteer[];
  blocks: VolunteerBlock[];
  skillRevocations: SkillRevocation[];
  plans: RosterPlan[];
  shifts: Shift[];
  attendances: Attendance[];
  handovers: Handover[];
  bookings: Booking[];
}

export type Command =
  | { type: 'RegisterFamily'; commandId: string; input: { name: string; size: number; needsAccessible: boolean; coRoomConsent: boolean; consentRoomChange: boolean } }
  | { type: 'CreateDraft'; commandId: string; familyId: string; roomId: string }
  | { type: 'CancelDraft'; commandId: string; assignmentId: string }
  | { type: 'SubmitCheckIn'; commandId: string; assignmentId: string }
  | { type: 'RegisterLeave'; commandId: string; familyId: string; strategy: ProtectionStrategy; protectionRoomId?: string; expectedReturnAt: number }
  | { type: 'ConfirmReturn'; commandId: string; familyId: string }
  | { type: 'ExtendPromise'; commandId: string; familyId: string; newExpectedReturnAt: number }
  | { type: 'SubmitCheckout'; commandId: string; familyId: string }
  | { type: 'AddTaskNote'; commandId: string; taskId: string; note: string }
  | { type: 'CloseRoom'; commandId: string; roomId: string; reason: string }
  | { type: 'ReopenRoom'; commandId: string; roomId: string }
  | { type: 'AdvanceClock'; commandId: string; toVirtual: number }
  | { type: 'ResetDemo'; commandId: string }
  | { type: 'FinalizeDue'; commandId: string }
  // ---- 排班与开台 ----
  | {
      type: 'RegisterVolunteer';
      commandId: string;
      input: { name: string; skills: CounterId[]; available: Interval[] };
    }
  | {
      type: 'AddVolunteerBlock';
      commandId: string;
      volunteerId: string;
      kind: BlockKind;
      start: number;
      end: number;
      label: string;
    }
  | { type: 'RevokeSkill'; commandId: string; volunteerId: string; counter: CounterId; at?: number }
  | { type: 'RestoreSkill'; commandId: string; volunteerId: string; counter: CounterId; at?: number }
  | {
      type: 'GenerateRoster';
      commandId: string;
      strategy: Exclude<RosterStrategy, 'manual'>;
      windowStart: number;
      windowEnd: number;
    }
  | {
      type: 'ManualAssignShift';
      commandId: string;
      volunteerId: string;
      counter: CounterId;
      start: number;
      end: number;
    }
  | { type: 'OpenCounterWindow'; commandId: string; counter: CounterId; start: number; end: number }
  | { type: 'CancelShift'; commandId: string; shiftId: string }
  | { type: 'SignIn'; commandId: string; volunteerId: string; counter: CounterId; at?: number }  | {
      type: 'SignOut';
      commandId: string;
      attendanceId: string;
      at: number;
      reportedAt?: number;
      note?: string;
    }
  | {
      type: 'RequestHandover';
      commandId: string;
      counter: CounterId;
      toVolunteerId: string;
      linkedSwap: boolean;
      /** 联动换岗时的补位者（不填则仅把人移过来、原柜台暂停） */
      fillVolunteerId?: string;
    }
  | { type: 'ConfirmHandover'; commandId: string; handoverId: string; side: 'outgoing' | 'incoming' }
  | { type: 'CancelHandover'; commandId: string; handoverId: string }
  | { type: 'CreateBooking'; commandId: string; counter: CounterId; slotStart: number; slotEnd: number; residentRef: string }
  | { type: 'RescheduleBooking'; commandId: string; bookingId: string; slotStart: number; slotEnd: number }
  | { type: 'CancelBooking'; commandId: string; bookingId: string }
  | { type: 'ServeBooking'; commandId: string; bookingId: string };

export interface CmdCtx {
  role: Role;
  realNow: number;
  /** 志愿者角色操作时代表的具体志愿者（用于约束本人签到 / 确认） */
  volunteerId?: string;
}

export interface CmdOutcome {
  state: ShelterState;
  receipts: Receipt[];
  error?: string;
  /** 是否产生了需要持久化/广播的变化 */
  changed: boolean;
}
