/**
 * 柜台排班与开台：区间覆盖计算、班表生成、覆盖/冲突报告。
 *
 * 关键约束（全部以“绝对时间区间”检验，而不是把每人总工时相加）：
 * - 每个柜台在任一时刻都需要一名“有相应技能、实际签到在岗”的人；
 * - 名义排班（planned）绝不等于实际在岗（actual），只有签到产生的出勤才算实际覆盖；
 * - 同一志愿者同一时刻不能支撑两个柜台；
 * - 休息/临时任务、技能资格撤销、迟到签到都会从覆盖区间中扣除；
 * - 全部时间使用绝对毫秒时间戳，跨日班次无需特殊分支。
 */
import { fmtTime } from './format';
import type {
  Attendance,
  Counter,
  CounterId,
  Interval,
  RosterPlan,
  ShelterState,
  Shift,
  Volunteer,
} from './types';

export const COUNTER_ORDER: CounterId[] = ['A', 'B'];

export const COUNTER_FULL_NAME: Record<CounterId, string> = {
  A: '接待柜台A',
  B: '物资柜台B',
};

export const ROSTER_STRATEGY_LABEL: Record<RosterPlan['strategy'], string> = {
  fixed_crossskilled: '固定跨技能守台（短时志愿者替休）',
  short_shift: '短时主班 + 跨技能机动',
  manual: '手工排班',
};

const INF = Number.MAX_SAFE_INTEGER;

// ---------------------------------------------------------------------------
// 区间运算
// ---------------------------------------------------------------------------

export function mergeIntervals(input: Interval[]): Interval[] {
  const list = input
    .filter((i) => i.end > i.start)
    .map((i) => ({ start: i.start, end: i.end }))
    .sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of list) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push(i);
  }
  return out;
}

export function subtractIntervals(base: Interval[], cuts: Interval[]): Interval[] {
  let result = mergeIntervals(base);
  for (const cut of mergeIntervals(cuts)) {
    const next: Interval[] = [];
    for (const seg of result) {
      if (cut.end <= seg.start || cut.start >= seg.end) {
        next.push(seg);
        continue;
      }
      if (cut.start > seg.start) next.push({ start: seg.start, end: cut.start });
      if (cut.end < seg.end) next.push({ start: cut.end, end: seg.end });
    }
    result = next;
  }
  return result;
}

export function intersectInterval(a: Interval, b: Interval): Interval | undefined {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  return end > start ? { start, end } : undefined;
}

export function intersectIntervals(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const x of a) for (const y of b) {
    const z = intersectInterval(x, y);
    if (z) out.push(z);
  }
  return mergeIntervals(out);
}

export function clampIntervals(list: Interval[], start: number, end: number): Interval[] {
  return intersectIntervals(list, [{ start, end }]);
}

/** 在 [start,end] 内未被 list 覆盖的缺口 */
export function gapsWithin(list: Interval[], start: number, end: number): Interval[] {
  if (end <= start) return [];
  const covered = mergeIntervals(clampIntervals(list, start, end));
  const gaps: Interval[] = [];
  let cur = start;
  for (const c of covered) {
    if (c.start > cur) gaps.push({ start: cur, end: Math.min(c.start, end) });
    cur = Math.max(cur, c.end);
  }
  if (cur < end) gaps.push({ start: cur, end });
  return gaps;
}

export function coversRange(list: Interval[], start: number, end: number): boolean {
  return end <= start ? true : gapsWithin(list, start, end).length === 0;
}

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

/** 区间标签：跨日时给结束时间加“次日”；开放端显示“起” */
export function fmtRange(i: Interval): string {
  if (!Number.isFinite(i.end)) return `${fmtTime(i.start)} 起`;
  if (i.end === INF) return `${fmtTime(i.start)} 起`;
  const a = new Date(i.start);
  const b = new Date(i.end);
  const sameDay = a.toDateString() === b.toDateString();
  return `${fmtTime(i.start)}–${sameDay ? '' : '次日'}${fmtTime(i.end)}`;
}

/** 预约时段标签 */
export function fmtSlot(s: { slotStart: number; slotEnd: number }): string {
  return fmtRange({ start: s.slotStart, end: s.slotEnd });
}

// ---------------------------------------------------------------------------
// 志愿者属性
// ---------------------------------------------------------------------------

export function volunteerById(state: ShelterState, id: string): Volunteer | undefined {
  return state.volunteers.find((v) => v.id === id);
}

export function blockIntervals(state: ShelterState, volunteerId: string): Interval[] {
  return mergeIntervals(
    state.blocks.filter((b) => b.volunteerId === volunteerId).map((b) => ({ start: b.start, end: b.end })),
  );
}

export function revocationIntervals(
  state: ShelterState,
  volunteerId: string,
  counter: CounterId,
): Interval[] {
  return mergeIntervals(
    state.skillRevocations
      .filter((r) => r.volunteerId === volunteerId && r.counter === counter)
      .map((r) => ({ start: r.from, end: r.to ?? INF })),
  );
}

export function skillActiveAt(
  state: ShelterState,
  v: Volunteer,
  counter: CounterId,
  at: number,
): boolean {
  if (!v.skills.includes(counter)) return false;
  return !revocationIntervals(state, v.id, counter).some((i) => i.start <= at && at < i.end);
}

export function skillActiveOver(
  state: ShelterState,
  v: Volunteer,
  counter: CounterId,
  start: number,
  end: number,
): boolean {
  if (!v.skills.includes(counter)) return false;
  return revocationIntervals(state, v.id, counter).every((r) => !overlaps(r, { start, end }));
}

export function availableAt(v: Volunteer, at: number): boolean {
  return v.available.some((i) => i.start <= at && at < i.end);
}

export function availableOver(v: Volunteer, start: number, end: number): boolean {
  return coversRange(v.available, start, end);
}

/** 覆盖 at 的可用区间结束时刻（用于推算替岗计划结束） */
export function availabilityEndAt(v: Volunteer, at: number): number | undefined {
  return v.available.find((i) => i.start <= at && at < i.end)?.end;
}

export function blockedAt(state: ShelterState, volunteerId: string, at: number): boolean {
  return state.blocks.some((b) => b.volunteerId === volunteerId && b.start <= at && at < b.end);
}

export function isCrossSkilled(v: Volunteer): boolean {
  return COUNTER_ORDER.every((c) => v.skills.includes(c));
}

// ---------------------------------------------------------------------------
// 柜台开放窗口
// ---------------------------------------------------------------------------

export function counterById(state: ShelterState, id: CounterId): Counter | undefined {
  return state.counters.find((c) => c.id === id);
}

export function sortedWindows(counter: Counter): Interval[] {
  return [...counter.windows].sort((a, b) => a.start - b.start);
}

export function counterWindowContaining(counter: Counter, start: number, end: number): Interval | undefined {
  return sortedWindows(counter).find((w) => w.start <= start && end <= w.end);
}

/** at 时刻之后（含）最近的开放窗口范围 */
export function remainingOpenWindows(counter: Counter, at: number): Interval[] {
  return sortedWindows(counter)
    .filter((w) => w.end > at)
    .map((w) => ({ start: Math.max(w.start, at), end: w.end }));
}

export function windowEndAt(counter: Counter, at: number): number | undefined {
  return sortedWindows(counter).find((w) => w.start <= at && at < w.end)?.end;
}

// ---------------------------------------------------------------------------
// 班次 / 出勤的有效区间
// ---------------------------------------------------------------------------

export function shiftEffectiveIntervals(state: ShelterState, s: Shift): Interval[] {
  if (s.status !== 'planned') return [];
  const v = volunteerById(state, s.volunteerId);
  if (!v || !v.skills.includes(s.counter)) return [];
  let ivs = [{ start: s.start, end: s.end }];
  ivs = intersectIntervals(ivs, v.available);
  ivs = subtractIntervals(ivs, blockIntervals(state, v.id));
  ivs = subtractIntervals(ivs, revocationIntervals(state, v.id, s.counter));
  const counter = counterById(state, s.counter);
  if (counter) ivs = intersectIntervals(ivs, counter.windows);
  return ivs;
}

export function plannedIntervals(
  state: ShelterState,
  counter: CounterId,
  start?: number,
  end?: number,
): Interval[] {
  const list = state.shifts
    .filter((s) => s.counter === counter && s.status === 'planned')
    .flatMap((s) => shiftEffectiveIntervals(state, s));
  const merged = mergeIntervals(list);
  return start !== undefined && end !== undefined ? clampIntervals(merged, start, end) : merged;
}

/** 出勤实际覆盖的结束时刻：离岗时间；未离岗则取计划结束与柜台窗口结束的较早者 */
export function attendanceEndAt(state: ShelterState, a: Attendance): number {
  const counter = counterById(state, a.counter);
  const cap = counter ? (windowEndAt(counter, a.signedInAt) ?? a.plannedEndAt) : INF;
  return a.signedOutAt ?? Math.min(a.plannedEndAt, cap);
}

export function attendanceIntervals(state: ShelterState, a: Attendance): Interval[] {
  let ivs: Interval[] = [{ start: a.signedInAt, end: attendanceEndAt(state, a) }];
  ivs = subtractIntervals(ivs, blockIntervals(state, a.volunteerId));
  ivs = subtractIntervals(ivs, revocationIntervals(state, a.volunteerId, a.counter));
  return ivs;
}

export function actualIntervals(
  state: ShelterState,
  counter: CounterId,
  start?: number,
  end?: number,
): Interval[] {
  const merged = mergeIntervals(
    state.attendances.filter((a) => a.counter === counter).flatMap((a) => attendanceIntervals(state, a)),
  );
  return start !== undefined && end !== undefined ? clampIntervals(merged, start, end) : merged;
}

export function openAttendanceOf(
  state: ShelterState,
  volunteerId: string,
  counter?: CounterId,
): Attendance | undefined {
  return state.attendances.find(
    (a) => a.volunteerId === volunteerId && a.signedOutAt === undefined && (!counter || a.counter === counter),
  );
}

export function attendanceAt(
  state: ShelterState,
  counter: CounterId,
  at: number,
): Attendance | undefined {
  return state.attendances.find(
    (a) => a.counter === counter && a.signedInAt <= at && at < attendanceEndAt(state, a),
  );
}

/** 该志愿者在 [start,end] 内是否已经被其他班次/出勤占用 */
export function volunteerBusyOver(
  state: ShelterState,
  volunteerId: string,
  start: number,
  end: number,
  ignoreShiftId?: string,
): string | undefined {
  for (const s of state.shifts) {
    if (s.status !== 'planned' || s.volunteerId !== volunteerId || s.id === ignoreShiftId) continue;
    if (overlaps({ start: s.start, end: s.end }, { start, end })) {
      return `与已排班次 ${COUNTER_FULL_NAME[s.counter]} ${fmtRange(s)} 重叠`;
    }
  }
  for (const a of state.attendances) {
    const aEnd = attendanceEndAt(state, a);
    if (a.volunteerId === volunteerId && overlaps({ start: a.signedInAt, end: aEnd }, { start, end })) {
      return `与${COUNTER_FULL_NAME[a.counter]}实际出勤 ${fmtRange({ start: a.signedInAt, end: aEnd })} 重叠`;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 班次冲突
// ---------------------------------------------------------------------------

export function shiftIssues(state: ShelterState, s: Shift): string[] {
  if (s.status !== 'planned') return [];
  const issues: string[] = [];
  const v = volunteerById(state, s.volunteerId);
  if (!v) return ['志愿者不存在'];
  const counter = counterById(state, s.counter);
  if (!counter) return ['柜台不存在'];
  if (!v.skills.includes(s.counter)) issues.push(`无${COUNTER_FULL_NAME[s.counter]}技能`);
  if (!counterWindowContaining(counter, s.start, s.end)) {
    issues.push('班次超出柜台开放窗口');
  }
  const availGaps = gapsWithin(v.available, s.start, s.end);
  if (availGaps.length) issues.push(`超出登记可用时间（${availGaps.map(fmtRange).join('、')}）`);
  for (const b of state.blocks.filter((x) => x.volunteerId === v.id)) {
    if (overlaps({ start: b.start, end: b.end }, { start: s.start, end: s.end })) {
      issues.push(`与${b.kind === 'rest' ? '休息' : '临时任务'}「${b.label}」${fmtRange(b)} 重叠`);
    }
  }
  const revHit = revocationIntervals(state, v.id, s.counter).filter((r) =>
    overlaps(r, { start: s.start, end: s.end }),
  );
  if (revHit.length) issues.push(`技能资格已在 ${revHit.map(fmtRange).join('、')} 撤销`);
  for (const o of state.shifts) {
    if (o.id === s.id || o.status !== 'planned' || o.volunteerId !== v.id) continue;
    if (o.counter !== s.counter && overlaps({ start: o.start, end: o.end }, { start: s.start, end: s.end })) {
      issues.push(
        `同一志愿者同时段被排到${COUNTER_FULL_NAME[o.counter]}（${fmtRange(o)}），一人不能同时支撑两个柜台`,
      );
    }
  }
  return issues;
}

export interface RosterConflict {
  shiftId: string;
  volunteerId: string;
  counter: CounterId;
  message: string;
}

export function rosterConflicts(state: ShelterState): RosterConflict[] {
  return state.shifts
    .filter((s) => s.status === 'planned')
    .flatMap((s) => {
      const issues = shiftIssues(state, s);
      return issues.length
        ? [
            {
              shiftId: s.id,
              volunteerId: s.volunteerId,
              counter: s.counter,
              message: `${COUNTER_FULL_NAME[s.counter]} ${fmtRange(s)}：${issues.join('；')}`,
            },
          ]
        : [];
    });
}

// ---------------------------------------------------------------------------
// 覆盖报告
// ---------------------------------------------------------------------------

export interface CoveragePerson {
  volunteerId: string;
  name: string;
  start: number;
  end: number;
}

export interface CounterCoverage {
  counter: CounterId;
  name: string;
  windows: Interval[];
  planIntervals: Interval[];
  /** 每个开放窗口内的计划缺口 */
  planGaps: { window: Interval; gaps: Interval[] }[];
  actualIntervals: Interval[];
  /** 从当前时间起，每个尚未结束的开放窗口内的实际缺口 */
  actualGaps: { window: Interval; gaps: Interval[] }[];
  onDuty: CoveragePerson[];
  pendingHandoverIds: string[];
  /** 受影响预约（等待 / 改约） */
  affectedBookingIds: string[];
  /** 当前可机动的跨技能人员 */
  mobile: { volunteerId: string; name: string }[];
}

export function coverageReport(state: ShelterState, at: number = state.virtualNow): CounterCoverage[] {
  return state.counters.map((counter) => {
    const windows = sortedWindows(counter);
    const planAll = plannedIntervals(state, counter.id);
    const actualAll = actualIntervals(state, counter.id);
    const planGaps = windows.map((w) => ({ window: w, gaps: gapsWithin(planAll, w.start, w.end) }));
    const actualGaps = remainingOpenWindows(counter, at).map((w) => ({
      window: w,
      gaps: gapsWithin(actualAll, w.start, w.end),
    }));
    const onDuty = state.attendances
      .filter((a) => a.counter === counter.id && a.signedInAt <= at && at < attendanceEndAt(state, a))
      .filter((a) => attendanceIntervals(state, a).some((i) => i.start <= at && at < i.end))
      .map((a) => ({
        volunteerId: a.volunteerId,
        name: volunteerById(state, a.volunteerId)?.name ?? a.volunteerId,
        start: a.signedInAt,
        end: attendanceEndAt(state, a),
      }));
    const pendingHandoverIds = state.handovers
      .filter((h) => h.counter === counter.id && h.status === 'pending')
      .map((h) => h.id);
    const affectedBookingIds = state.bookings
      .filter((b) => b.counter === counter.id && (b.status === 'waiting' || b.wasRescheduled))
      .map((b) => b.id);
    const mobile = mobileReserveAt(state, at);
    return {
      counter: counter.id,
      name: counter.name,
      windows,
      planIntervals: planAll,
      planGaps,
      actualIntervals: actualAll,
      actualGaps,
      onDuty,
      pendingHandoverIds,
      affectedBookingIds,
      mobile,
    };
  });
}

/** 某时刻可机动的跨技能人员：两岗技能有效、可用、未被休息/任务占用、未在岗、未被班次占用 */
export function mobileReserveAt(state: ShelterState, at: number): { volunteerId: string; name: string }[] {
  return state.volunteers
    .filter((v) => isCrossSkilled(v))
    .filter((v) => skillActiveAt(state, v, 'A', at) && skillActiveAt(state, v, 'B', at))
    .filter((v) => availableAt(v, at) && !blockedAt(state, v.id, at))
    .filter((v) => !openAttendanceOf(state, v.id))
    .filter(
      (v) =>
        !state.shifts.some(
          (s) =>
            s.status === 'planned' &&
            s.volunteerId === v.id &&
            shiftEffectiveIntervals(state, s).some((i) => i.start <= at && at < i.end),
        ),
    )
    .map((v) => ({ volunteerId: v.id, name: v.name }));
}

/** 柜台是否暂停放号：存在待确认接班，或当前时刻在开放窗口内却无人实际在岗 */
export function counterSuspended(
  state: ShelterState,
  counter: CounterId,
  at: number = state.virtualNow,
): boolean {
  if (state.handovers.some((h) => h.counter === counter && h.status === 'pending')) return true;
  const c = counterById(state, counter);
  if (!c) return true;
  const inside = c.windows.some((w) => w.start <= at && at < w.end);
  if (!inside) return false;
  return !actualIntervals(state, counter).some((i) => i.start <= at && at < i.end);
}

// ---------------------------------------------------------------------------
// 班表生成
// ---------------------------------------------------------------------------

export interface ShiftDraft {
  volunteerId: string;
  counter: CounterId;
  start: number;
  end: number;
  kind: 'main' | 'relief';
}

export interface GeneratedRoster {
  drafts: ShiftDraft[];
  notes: string[];
  error?: string;
}

export function generateFixedCrossSkilled(
  state: ShelterState,
  windowStart: number,
  windowEnd: number,
): GeneratedRoster {
  const notes: string[] = [];
  const candidates = [...state.volunteers]
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    .filter(
      (v) =>
        isCrossSkilled(v) &&
        availableOver(v, windowStart, windowEnd) &&
        COUNTER_ORDER.every((c) => skillActiveOver(state, v, c, windowStart, windowEnd)),
    );
  if (candidates.length < 2) {
    return {
      drafts: [],
      notes,
      error: `固定守台方案需要至少 2 名全程可用、具备两柜台技能且资质有效的志愿者，当前只有 ${candidates.length} 名`,
    };
  }
  const [aVol, bVol] = candidates;
  const drafts: ShiftDraft[] = [
    { volunteerId: aVol.id, counter: 'A', start: windowStart, end: windowEnd, kind: 'main' },
    { volunteerId: bVol.id, counter: 'B', start: windowStart, end: windowEnd, kind: 'main' },
  ];
  notes.push(`固定守台：${aVol.name} 守 A，${bVol.name} 守 B（交接少、居民容易找到固定人员）`);
  const mains: { counter: CounterId; vol: Volunteer }[] = [
    { counter: 'A', vol: aVol },
    { counter: 'B', vol: bVol },
  ];
  for (const { counter, vol } of mains) {
    const gaps = clampIntervals(blockIntervals(state, vol.id), windowStart, windowEnd);
    for (const gap of gaps) {
      const assigned = new Set(drafts.map((d) => d.volunteerId));
      const relief = [...state.volunteers]
        .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
        .find(
          (v) =>
            !assigned.has(v.id) &&
            v.skills.includes(counter) &&
            availableOver(v, gap.start, gap.end) &&
            blockIntervals(state, v.id).every((b) => !overlaps(b, gap)) &&
            skillActiveOver(state, v, counter, gap.start, gap.end),
        );
      if (relief) {
        drafts.push({ volunteerId: relief.id, counter, start: gap.start, end: gap.end, kind: 'relief' });
        notes.push(`替休：${relief.name} 覆盖 ${COUNTER_FULL_NAME[counter]} ${fmtRange(gap)}（${vol.name} 休息/临时任务）`);
      } else {
        notes.push(`⚠ ${COUNTER_FULL_NAME[counter]} ${fmtRange(gap)} 无替休候选人，计划覆盖存在缺口`);
      }
    }
  }
  return { drafts, notes };
}

export function generateShortShift(
  state: ShelterState,
  windowStart: number,
  windowEnd: number,
): GeneratedRoster {
  const notes: string[] = [];
  const cuts: number[] = [windowStart, windowEnd];
  const pushCut = (t: number) => {
    if (t > windowStart && t < windowEnd) cuts.push(t);
  };
  for (const v of state.volunteers) for (const i of v.available) { pushCut(i.start); pushCut(i.end); }
  for (const b of state.blocks) { pushCut(b.start); pushCut(b.end); }
  for (const r of state.skillRevocations) {
    pushCut(r.from);
    if (r.to !== undefined) pushCut(r.to);
  }
  const points = [...new Set(cuts)].sort((a, b) => a - b);
  const segments: Interval[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    if (points[i + 1] > points[i]) segments.push({ start: points[i], end: points[i + 1] });
  }
  const minutes = new Map<string, number>();
  const drafts: ShiftDraft[] = [];
  const addMinutes = (id: string, ms: number) => minutes.set(id, (minutes.get(id) ?? 0) + ms);

  const eligible = (seg: Interval, counter: CounterId) =>
    [...state.volunteers]
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
      .filter(
        (v) =>
          v.skills.includes(counter) &&
          availableOver(v, seg.start, seg.end) &&
          blockIntervals(state, v.id).every((b) => !overlaps(b, seg)) &&
          skillActiveOver(state, v, counter, seg.start, seg.end),
      );

  for (const seg of segments) {
    const remaining: CounterId[] = [...COUNTER_ORDER];
    const used = new Set<string>();
    // 第一轮：优先把“只有单一技能”的短时志愿者排进主班
    for (const counter of COUNTER_ORDER) {
      if (!remaining.includes(counter)) continue;
      const specialist = eligible(seg, counter).find((v) => v.skills.length === 1 && !used.has(v.id));
      if (!specialist) continue;
      drafts.push({ volunteerId: specialist.id, counter, start: seg.start, end: seg.end, kind: 'main' });
      used.add(specialist.id);
      addMinutes(specialist.id, seg.end - seg.start);
      remaining.splice(remaining.indexOf(counter), 1);
    }
    // 第二轮：剩余柜台由跨技能人员补位（已排时长最少优先，保留一人可机动）
    for (const counter of [...remaining]) {
      const cands = eligible(seg, counter)
        .filter((v) => !used.has(v.id))
        .sort((a, b) => (minutes.get(a.id) ?? 0) - (minutes.get(b.id) ?? 0) || a.name.localeCompare(b.name, 'zh'));
      const v = cands[0];
      if (!v) {
        notes.push(`⚠ ${COUNTER_FULL_NAME[counter]} ${fmtRange(seg)} 无可用志愿者，计划覆盖存在缺口`);
        continue;
      }
      drafts.push({ volunteerId: v.id, counter, start: seg.start, end: seg.end, kind: 'main' });
      used.add(v.id);
      addMinutes(v.id, seg.end - seg.start);
      remaining.splice(remaining.indexOf(counter), 1);
    }
    const mobile = [...state.volunteers].filter(
      (v) =>
        isCrossSkilled(v) &&
        !used.has(v.id) &&
        availableOver(v, seg.start, seg.end) &&
        blockIntervals(state, v.id).every((b) => !overlaps(b, seg)) &&
        COUNTER_ORDER.every((c) => skillActiveOver(state, v, c, seg.start, seg.end)),
    );
    notes.push(
      mobile.length
        ? `${fmtRange(seg)}：另有机动 ${mobile.map((m) => m.name).join('、')}`
        : `${fmtRange(seg)}：无跨技能机动人员（临时缺岗需另找替补）`,
    );
  }
  notes.unshift('短时主班 + 跨技能机动：补临时缺岗较快，但接班确认更多');
  return { drafts, notes };
}

// ---------------------------------------------------------------------------
// 预约覆盖
// ---------------------------------------------------------------------------

export function bookingCovered(state: ShelterState, booking: ShelterState['bookings'][number]): boolean {
  return coversRange(actualIntervals(state, booking.counter), booking.slotStart, booking.slotEnd);
}

export function bookingAssignee(
  state: ShelterState,
  booking: ShelterState['bookings'][number],
): Attendance | undefined {
  return state.attendances.find(
    (a) =>
      a.counter === booking.counter &&
      a.signedInAt <= booking.slotStart &&
      booking.slotEnd <= attendanceEndAt(state, a),
  );
}
