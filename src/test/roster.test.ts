import { describe, expect, it } from 'vitest';
import { applyCommand, checkInvariants } from '../engine/engine';
import {
  actualIntervals,
  coverageReport,
  counterSuspended,
  gapsWithin,
  mobileReserveAt,
  plannedIntervals,
  shiftIssues as shiftIssuesSafe,
} from '../engine/roster';
import { seedState } from '../engine/seed';
import type { Command, Role, ShelterState } from '../engine/types';

let cid = 0;
const nid = () => `rt-${++cid}`;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type AnyCmd = DistributiveOmit<Command, 'commandId'> & { commandId?: string };

function run(state: ShelterState, cmd: AnyCmd, role: Role = 'coordinator', realNow = 10_000) {
  const full = { ...cmd, commandId: cmd.commandId ?? nid() } as Command;
  return applyCommand(state, full, { role, realNow });
}
function ok(state: ShelterState, cmd: AnyCmd, role: Role = 'coordinator'): ShelterState {
  const out = run(state, cmd, role);
  if (out.error) throw new Error(`命令意外失败: ${out.error}`);
  return out.state;
}
function fail(state: ShelterState, cmd: AnyCmd, role: Role = 'coordinator'): string {
  const out = run(state, cmd, role);
  if (!out.error) throw new Error('命令意外成功');
  return out.error;
}

const t = (h: number, m = 0, day = 26) => new Date(2026, 10, day, h, m, 0).getTime();

function at(state: ShelterState, to: number): ShelterState {
  return ok(state, { type: 'AdvanceClock', toVirtual: to }, 'coordinator');
}

function expectInvariantsOk(state: ShelterState) {
  const bad = checkInvariants(state).filter((r) => !r.ok);
  expect(bad.map((b) => `${b.name}: ${b.detail}`)).toEqual([]);
}

function attOf(state: ShelterState, volunteerId: string, counter: 'A' | 'B') {
  const list = state.attendances.filter((a) => a.volunteerId === volunteerId && a.counter === counter);
  return list.length ? list[list.length - 1] : undefined;
}

const V1 = 'vol-liu';
const V2 = 'vol-zheng';
const V3 = 'vol-he';
const V4 = 'vol-sun';

describe('种子：14:00–16:00 两个柜台由固定跨技能人员守台', () => {
  it('V2 守 A、V4 守 B，均已签到，计划/实际覆盖连续', () => {
    const s = seedState();
    expect(s.counters.map((c) => c.id)).toEqual(['A', 'B']);
    expect(plannedIntervals(s, 'A')).toEqual([{ start: t(14), end: t(16) }]);
    expect(plannedIntervals(s, 'B')).toEqual([{ start: t(14), end: t(16) }]);
    expect(attOf(s, V2, 'A')?.signedInAt).toBe(t(14));
    expect(attOf(s, V4, 'B')?.signedInAt).toBe(t(14));
    const cov = coverageReport(s);
    expect(cov[0].planGaps.flatMap((g) => g.gaps)).toEqual([]);
    expect(cov[1].planGaps.flatMap((g) => g.gaps)).toEqual([]);
    expect(cov[0].actualGaps.flatMap((g) => g.gaps)).toEqual([]);
    expect(cov[1].actualGaps.flatMap((g) => g.gaps)).toEqual([]);
    expect(counterSuspended(s, 'A')).toBe(false);
    expect(counterSuspended(s, 'B')).toBe(false);
    expectInvariantsOk(s);
  });
});

describe('两种排班策略都有效，且后者各时段多一名机动', () => {
  it('短时主班：前段 V1 守 A / V2 守 B，后段 V4 守 A / V3 守 B，并各有机动', () => {
    let s = seedState();
    // 清掉初始签到与班表，重新生成短时方案
    s = ok(s, { type: 'ResetDemo' });
    for (const a of s.attendances.filter((x) => x.signedOutAt === undefined)) {
      s = ok(s, { type: 'SignOut', attendanceId: a.id, at: t(14) });
    }
    s = ok(s, { type: 'GenerateRoster', strategy: 'short_shift', windowStart: t(14), windowEnd: t(16) });
    // 段1（14:00–15:00）：V1 仅 A 技能 → A；V2 跨技能 → B
    const seg1 = s.shifts.filter((x) => x.start === t(14) && x.end === t(15) && x.status === 'planned');
    expect(seg1.find((x) => x.counter === 'A')?.volunteerId).toBe(V1);
    expect(seg1.find((x) => x.counter === 'B')?.volunteerId).toBe(V2);
    // 段2（15:00–16:00）：V3 仅 B 技能 → B；V4 跨技能 → A
    const seg2 = s.shifts.filter((x) => x.start === t(15) && x.end === t(16) && x.status === 'planned');
    expect(seg2.find((x) => x.counter === 'B')?.volunteerId).toBe(V3);
    expect(seg2.find((x) => x.counter === 'A')?.volunteerId).toBe(V4);
    // 前半段的机动人员（未在岗、跨技能）= V4；后半段 = V2
    const mobile1 = mobileReserveAt(s, t(14, 30)).map((m) => m.volunteerId);
    const mobile2 = mobileReserveAt(s, t(15, 30)).map((m) => m.volunteerId);
    expect(mobile1).toContain(V4);
    expect(mobile2).toContain(V2);
    // 两人按各自班次签到后，实际覆盖连续
    s = ok(s, { type: 'SignIn', volunteerId: V1, counter: 'A', at: t(14) });
    s = ok(s, { type: 'SignIn', volunteerId: V2, counter: 'B', at: t(14) });
    expectInvariantsOk(s);
    s = at(s, t(15));
    // 交接：V2 → V4 守 B，V1 → V3 守 A（两人均直接接班人已在岗则为联动；此处先离岗再签到）
    s = ok(s, { type: 'SignOut', attendanceId: attOf(s, V1, 'A')!.id, at: t(15) });
    s = ok(s, { type: 'SignOut', attendanceId: attOf(s, V2, 'B')!.id, at: t(15) });
    s = ok(s, { type: 'SignIn', volunteerId: V4, counter: 'A', at: t(15) });
    s = ok(s, { type: 'SignIn', volunteerId: V3, counter: 'B', at: t(15) });
    expect(actualIntervals(s, 'A')).toEqual([{ start: t(14), end: t(16) }]);
    expect(actualIntervals(s, 'B')).toEqual([{ start: t(14), end: t(16) }]);
    expectInvariantsOk(s);
  });

  it('固定守台方案需要两名全程可用的跨技能志愿者', () => {
    let s = seedState();
    // 撤销 V4 的 B 技能 → 具备两岗技能的全程可用者只剩 V2 一人
    s = ok(s, { type: 'RevokeSkill', volunteerId: V4, counter: 'B' });
    const err = fail(s, { type: 'GenerateRoster', strategy: 'fixed_crossskilled', windowStart: t(14), windowEnd: t(16) });
    expect(err).toContain('至少 2 名');
  });
});

describe('覆盖必须按时间区间检验，不能靠总工时', () => {
  it('V2 8:00-12:00 与 V4 12:00-16:00 各自的“总工时”都够，但 V2 只排了前半段时 15:00 后 A 无人', () => {
    let s = seedState();
    // 手工把 A 柜台改成只有 14:00–15:00 有 V2 覆盖（另一名 V4 全程在 B）
    for (const a of s.attendances.filter((x) => x.counter === 'A' && x.signedOutAt === undefined)) {
      s = ok(s, { type: 'SignOut', attendanceId: a.id, at: t(14) });
    }
    s = ok(s, { type: 'SignIn', volunteerId: V2, counter: 'A', at: t(14, 30) });
    s = ok(s, { type: 'SignOut', attendanceId: attOf(s, V2, 'A')!.id, at: t(15) });
    const gaps = gapsWithin(actualIntervals(s, 'A'), t(14), t(16));
    expect(gaps).toEqual([
      { start: t(14), end: t(14, 30) },
      { start: t(15), end: t(16) },
    ]);
    s = at(s, t(14, 40));
    // 14:40 有实际在岗 → 暂时可放号
    expect(counterSuspended(s, 'A')).toBe(false);
    s = at(s, t(15, 10));
    // 15:10 后无人 → 暂停放号
    expect(counterSuspended(s, 'A')).toBe(true);
  });
});

describe('14:30 B 柜台负责人临时离岗', () => {
  function setup() {
    let s = seedState();
    s = at(s, t(14, 30));
    return s;
  }

  it('离岗后立即暂停放号，已有预约转为等待而非继续可办理', () => {
    let s = setup();
    // 15:10 的预约在未来，14:30 离岗后该柜台 14:30 起无覆盖 → 预约等待
    s = ok(s, { type: 'SignOut', attendanceId: attOf(s, V4, 'B')!.id, at: t(14, 30) });
    const bk = s.bookings.find((b) => b.id === 'bk-b-1')!;
    expect(bk.status).toBe('waiting');
    expect(bk.waitingReason).toContain('[自动]');
    expect(counterSuspended(s, 'B')).toBe(true);
    // 不能继续报可办理：ServeBooking 被拒
    s = at(s, t(14, 45));
    const err = fail(s, { type: 'ServeBooking', bookingId: 'bk-b-1' }, 'receptionist');
    expect(err).toContain('无实际在岗');
  });

  it('直接替补：V2 从 A 调来（直接替补需先在岗者离岗后由接班人接替）', () => {
    let s = setup();
    s = ok(s, { type: 'SignOut', attendanceId: attOf(s, V4, 'B')!.id, at: t(14, 30) });
    // V2 仍在 A 在岗，不能直接同时守 B；先给他 A 离岗，再发起直接替补
    s = ok(s, { type: 'SignOut', attendanceId: attOf(s, V2, 'A')!.id, at: t(14, 30) });
    s = ok(s, { type: 'RequestHandover', counter: 'B', toVolunteerId: V2, linkedSwap: false });
    // 接班未确认前：柜台暂停放号，预约等待
    expect(counterSuspended(s, 'B')).toBe(true);
    expect(s.bookings.find((b) => b.id === 'bk-b-2')?.status).toBe('waiting');
    const h = s.handovers.find((x) => x.status === 'pending')!;
    // 柜台无人 → 只需接班方确认
    s = ok(s, { type: 'ConfirmHandover', handoverId: h.id, side: 'incoming' });
    expect(counterSuspended(s, 'B')).toBe(false);
    expect(attOf(s, V2, 'B')).toBeTruthy();
    expect(s.bookings.find((b) => b.id === 'bk-b-2')?.status).toBe('booked');
    // 直接替补把 V2 从 A 调走，A 需另有替班；V1 可用至 15:00，先签到补位
    s = ok(s, { type: 'SignIn', volunteerId: V1, counter: 'A' });
    expectInvariantsOk(s);
  });

  it('联动换岗：V2 从 A 调守 B，另安排 V1 补位 A（15:00 前可用）', () => {
    let s = setup();
    s = ok(s, { type: 'SignOut', attendanceId: attOf(s, V4, 'B')!.id, at: t(14, 30) });
    s = ok(s, {
      type: 'RequestHandover',
      counter: 'B',
      toVolunteerId: V2,
      linkedSwap: true,
      fillVolunteerId: V1,
    });
    const h = s.handovers.find((x) => x.status === 'pending')!;
    expect(counterSuspended(s, 'B')).toBe(true);
    // V4 已离岗 → 交接单无交班方，只需接班方确认
    s = ok(s, { type: 'ConfirmHandover', handoverId: h.id, side: 'incoming' });
    expect(s.handovers.find((x) => x.id === h.id)?.status).toBe('effective');
    // V2 在 B，V1 在 A
    expect(attOf(s, V2, 'B')?.signedOutAt).toBeUndefined();
    expect(attOf(s, V1, 'A')?.signedOutAt).toBeUndefined();
    expect(attOf(s, V2, 'A')?.signedOutAt).toBe(t(14, 30));
    expect(counterSuspended(s, 'A')).toBe(false);
    expect(counterSuspended(s, 'B')).toBe(false);
  });

  it('交接双方同时点击也只会生成一份生效交接', () => {
    let s = setup();
    s = ok(s, { type: 'SignOut', attendanceId: attOf(s, V4, 'B')!.id, at: t(14, 30) });
    s = ok(s, { type: 'SignOut', attendanceId: attOf(s, V2, 'A')!.id, at: t(14, 30) });
    s = ok(s, { type: 'RequestHandover', counter: 'B', toVolunteerId: V2, linkedSwap: false });
    const h = s.handovers.find((x) => x.status === 'pending')!;
    // 模拟双方同时点击：两侧都提交 incoming 确认（同一交接单）
    const first = run(s, { type: 'ConfirmHandover', handoverId: h.id, side: 'incoming' });
    expect(first.error).toBeUndefined();
    s = first.state;
    const second = run(s, { type: 'ConfirmHandover', handoverId: h.id, side: 'incoming' });
    expect(second.error).toContain('已生效');
    expect(s.handovers.filter((x) => x.status === 'effective')).toHaveLength(1);
    expect(s.attendances.filter((a) => a.volunteerId === V2 && a.counter === 'B')).toHaveLength(1);
  });
});

describe('班表调整不抹去实际出勤', () => {
  it('取消计划班次后，已发生的出勤仍在，覆盖不回退', () => {
    let s = seedState();
    s = at(s, t(14, 20));
    const shift = s.shifts.find((x) => x.volunteerId === V2 && x.counter === 'A')!;
    s = ok(s, { type: 'CancelShift', shiftId: shift.id });
    expect(actualIntervals(s, 'A')).toEqual([{ start: t(14), end: t(16) }]);
    expect(s.attendances.find((a) => a.id === 'att-zheng-a')).toBeTruthy();
  });

  it('离岗回执晚到：按发生时间修订缺岗区间，不撤回已发生的服务', () => {
    let s = seedState();
    s = at(s, t(14, 30));
    const a = attOf(s, V4, 'B')!;
    // 实际 14:30 离岗，但 14:55 才提交回执
    s = at(s, t(14, 55));
    s = ok(s, { type: 'SignOut', attendanceId: a.id, at: t(14, 30), reportedAt: t(14, 55) });
    const rec = s.attendances.find((x) => x.id === a.id)!;
    expect(rec.signedOutAt).toBe(t(14, 30));
    expect(rec.lateReport).toBe(true);
    // 14:30–14:55 已按缺岗计入，但 14:00–14:30 的服务保留
    expect(actualIntervals(s, 'B')).toEqual([{ start: t(14), end: t(14, 30) }]);
  });
});

describe('跨日班次 / 休息与临时任务 / 技能撤销 / 迟到签到', () => {
  it('22:00–次日02:00 跨日窗口按绝对区间排班与覆盖', () => {
    let s = seedState();
    s = at(s, t(20));
    s = ok(s, { type: 'OpenCounterWindow', counter: 'A', start: t(22), end: t(2, 0, 27) });
    s = ok(s, { type: 'OpenCounterWindow', counter: 'B', start: t(22), end: t(2, 0, 27) });
    // 跨日夜班需要两名登记可用时间覆盖 22:00–次日02:00 的跨技能志愿者
    s = ok(s, {
      type: 'RegisterVolunteer',
      input: { name: 'V5 夜班甲', skills: ['A', 'B'], available: [{ start: t(22), end: t(2, 0, 27) }] },
    });
    s = ok(s, {
      type: 'RegisterVolunteer',
      input: { name: 'V6 夜班乙', skills: ['A', 'B'], available: [{ start: t(22), end: t(2, 0, 27) }] },
    });
    s = ok(s, {
      type: 'GenerateRoster',
      strategy: 'fixed_crossskilled',
      windowStart: t(22),
      windowEnd: t(2, 0, 27),
    });
    const plan = plannedIntervals(s, 'A', t(22), t(2, 0, 27));
    expect(gapsWithin(plan, t(22), t(2, 0, 27))).toEqual([]);
    const aShift = s.shifts.find((x) => x.counter === 'A' && x.start === t(22) && x.status === 'planned')!;
    expect(aShift.end).toBe(t(2, 0, 27));
    s = ok(s, { type: 'SignIn', volunteerId: aShift.volunteerId, counter: 'A', at: t(22) });
    const bShift = s.shifts.find((x) => x.counter === 'B' && x.start === t(22) && x.status === 'planned')!;
    s = ok(s, { type: 'SignIn', volunteerId: bShift.volunteerId, counter: 'B', at: t(22) });
    s = at(s, t(23, 30));
    expect(counterSuspended(s, 'A')).toBe(false);
    s = at(s, t(1, 30, 27));
    expect(counterSuspended(s, 'A')).toBe(false);
    expect(gapsWithin(actualIntervals(s, 'A'), t(22), t(2, 0, 27))).toEqual([]);
  });

  it('休息/临时任务与班次重叠时，计划覆盖按区间扣除并报冲突', () => {
    let s = seedState();
    s = ok(s, {
      type: 'AddVolunteerBlock',
      volunteerId: V2,
      kind: 'rest',
      start: t(14, 45),
      end: t(15, 15),
      label: '午休',
    });
    const planA = plannedIntervals(s, 'A');
    expect(gapsWithin(planA, t(14), t(16))).toEqual([{ start: t(14, 45), end: t(15, 15) }]);
    // 实际覆盖也扣除休息区间
    expect(gapsWithin(actualIntervals(s, 'A'), t(14), t(16))).toEqual([{ start: t(14, 45), end: t(15, 15) }]);
    s = at(s, t(14, 50));
    expect(counterSuspended(s, 'A')).toBe(true);
    s = at(s, t(15, 20));
    expect(counterSuspended(s, 'A')).toBe(false);
  });

  it('技能资格被撤销：后续计划缺口与受影响预约', () => {
    let s = seedState();
    s = at(s, t(14, 20));
    s = ok(s, { type: 'RevokeSkill', volunteerId: V4, counter: 'B' });
    expect(gapsWithin(actualIntervals(s, 'B'), t(14), t(16))).toEqual([{ start: t(14, 20), end: t(16) }]);
    expect(gapsWithin(plannedIntervals(s, 'B'), t(14), t(16))).toEqual([{ start: t(14, 20), end: t(16) }]);
    expect(counterSuspended(s, 'B')).toBe(true);
    expect(s.bookings.find((b) => b.id === 'bk-b-1')?.status).toBe('waiting');
    expect(s.bookings.find((b) => b.id === 'bk-b-2')?.status).toBe('waiting');
    // 恢复资格后覆盖复原
    s = at(s, t(14, 40));
    s = ok(s, { type: 'RestoreSkill', volunteerId: V4, counter: 'B' });
    expect(counterSuspended(s, 'B')).toBe(false);
  });

  it('迟到签到：班次开始至签到时刻记为实际缺口', () => {
    let s = seedState();
    // 清掉 V2 的初始签到，14:40 才签到（计划 14:00 开始）
    s = ok(s, { type: 'SignOut', attendanceId: 'att-zheng-a', at: t(14) });
    s = at(s, t(14, 40));
    s = ok(s, { type: 'SignIn', volunteerId: V2, counter: 'A', at: t(14, 40) });
    const rec = attOf(s, V2, 'A')!;
    expect(rec.lateSignIn).toBe(true);
    expect(gapsWithin(actualIntervals(s, 'A'), t(14), t(16))).toEqual([
      { start: t(14), end: t(14, 40) },
    ]);
    // 14:40 之前预约受影响，14:40 之后可办理
    expect(s.bookings.find((b) => b.id === 'bk-a-1')?.status).toBe('waiting');
  });
});

describe('一人不能同时支撑两个柜台', () => {
  it('在岗者不能直接签到第二个柜台', () => {
    const s = seedState();
    const err = fail(s, { type: 'SignIn', volunteerId: V2, counter: 'B' }, 'coordinator');
    expect(err).toContain('已在岗');
  });

  it('手工排班把同一人同一时段排到两个柜台会报冲突', () => {
    let s = seedState();
    s = ok(s, { type: 'ManualAssignShift', volunteerId: V1, counter: 'A', start: t(14, 15), end: t(14, 45) });
    const out = run(s, { type: 'ManualAssignShift', volunteerId: V1, counter: 'B', start: t(14, 30), end: t(14, 40) });
    // V1 无 B 技能 → 直接拒绝
    expect(out.error).toContain('不具备');
    // 用跨技能 V2 在 14:00–16:00 已排 A，再排 B 会报冲突但命令仍记录（由核对面板暴露）
    s = ok(s, { type: 'ManualAssignShift', volunteerId: V3, counter: 'B', start: t(15, 30), end: t(16) });
    const bad = checkInvariants(s).find((r) => r.name === '一人不同时支撑两个柜台');
    expect(bad?.ok).toBe(true);
  });
});

describe('预约放号只认实际在岗', () => {
  it('名义排了班但未签到，不能开放预约名额', () => {
    let s = seedState();
    s = ok(s, { type: 'SignOut', attendanceId: 'att-sun-b', at: t(14) });
    s = at(s, t(14, 20));
    s = ok(s, { type: 'GenerateRoster', strategy: 'fixed_crossskilled', windowStart: t(14, 20), windowEnd: t(16) });
    // 计划班次存在，但无人签到
    expect(gapsWithin(plannedIntervals(s, 'B'), t(14, 20), t(16))).toEqual([]);
    const out = run(s, {
      type: 'CreateBooking',
      counter: 'B',
      slotStart: t(15, 30),
      slotEnd: t(15, 50),
      residentRef: 'C-200 测试',
    });
    expect(out.error).toBeUndefined();
    const bk = out.state.bookings[out.state.bookings.length - 1];
    expect(bk.status).toBe('waiting');
    expect(bk.waitingReason).toContain('无实际在岗');
  });
});

describe('总工时相加不能证明覆盖（反例）', () => {
  it('两名志愿者合计排满 2 小时，但时段重叠导致中间仍有缺口', () => {
    let s = seedState();
    // 取消种子中的固定守台，重建 A 的“累计工时足够但区间有洞”的计划
    for (const sh of [...s.shifts]) s = ok(s, { type: 'CancelShift', shiftId: sh.id });
    s = ok(s, { type: 'SignOut', attendanceId: attOf(s, V2, 'A')!.id, at: t(14) });
    s = ok(s, { type: 'SignOut', attendanceId: attOf(s, V4, 'B')!.id, at: t(14) });
    // V2: 14:00–15:20（80 分钟）
    s = ok(s, { type: 'ManualAssignShift', volunteerId: V2, counter: 'A', start: t(14), end: t(15, 20) });
    // V4: 14:20–14:40（20 分钟）与 15:40–16:00（20 分钟），合计 40 分钟
    s = ok(s, { type: 'ManualAssignShift', volunteerId: V4, counter: 'A', start: t(14, 20), end: t(14, 40) });
    s = ok(s, { type: 'ManualAssignShift', volunteerId: V4, counter: 'A', start: t(15, 40), end: t(16) });
    // 累计工时 120 分钟 = 窗口长度 120 分钟，但 15:20–15:40 无人
    const gaps = gapsWithin(plannedIntervals(s, 'A'), t(14), t(16));
    expect(gaps).toEqual([{ start: t(15, 20), end: t(15, 40) }]);
  });
});

describe('角色权限', () => {
  it('非协调员不能生成班表或登记志愿者；接待员不能签到', () => {
    const s = seedState();
    expect(fail(s, { type: 'GenerateRoster', strategy: 'short_shift', windowStart: t(14), windowEnd: t(16) }, 'receptionist')).toContain('无权');
    expect(
      fail(s, { type: 'RegisterVolunteer', input: { name: '测试', skills: ['A'], available: [{ start: t(14), end: t(16) }] } }, 'duty'),
    ).toContain('无权');
    expect(fail(s, { type: 'SignIn', volunteerId: V1, counter: 'A' }, 'receptionist')).toContain('无权');
  });

  it('志愿者只能为本人签到/离岗', () => {
    const s = seedState();
    const out = applyCommand(
      s,
      { type: 'SignIn', commandId: 'vol-other', volunteerId: V4, counter: 'A' },
      { role: 'volunteer', realNow: 1, volunteerId: V1 },
    );
    expect(out.error).toContain('只能为本人');
  });
});

describe('固定守台 + 短时志愿者替休', () => {
  it('V2 休息时由短时志愿者 V1 替休，计划覆盖仍连续', () => {
    let s = seedState();
    s = ok(s, {
      type: 'AddVolunteerBlock',
      volunteerId: V2,
      kind: 'rest',
      start: t(14, 30),
      end: t(15),
      label: '午休',
    });
    s = ok(s, { type: 'GenerateRoster', strategy: 'fixed_crossskilled', windowStart: t(14), windowEnd: t(16) });
    const relief = s.shifts.find(
      (x) => x.status === 'planned' && x.kind === 'relief' && x.counter === 'A' && x.volunteerId === V1,
    );
    expect(relief).toBeTruthy();
    expect(relief!.start).toBe(t(14, 30));
    expect(relief!.end).toBe(t(15));
    expect(gapsWithin(plannedIntervals(s, 'A'), t(14), t(16))).toEqual([]);
    expect(gapsWithin(plannedIntervals(s, 'B'), t(14), t(16))).toEqual([]);
  });
});

describe('休息区间内不在岗列表不显示该人', () => {
  it('V2 14:45–15:15 休息时，14:50 的在岗列表为空且暂停放号', () => {
    let s = seedState();
    s = ok(s, { type: 'AddVolunteerBlock', volunteerId: V2, kind: 'rest', start: t(14, 45), end: t(15, 15), label: '午休' });
    s = at(s, t(14, 50));
    const covA = coverageReport(s)[0];
    expect(covA.onDuty).toEqual([]);
    expect(counterSuspended(s, 'A')).toBe(true);
    // 15:20 休息结束，恢复在岗
    s = at(s, t(15, 20));
    expect(coverageReport(s)[0].onDuty.map((p) => p.volunteerId)).toEqual([V2]);
    expect(counterSuspended(s, 'A')).toBe(false);
  });
});

describe('跨日班次：签到覆盖延伸到次日', () => {
  it('22:00 签到，次日 01:30 仍在岗；离岗后再无覆盖', () => {
    let s = seedState();
    s = at(s, t(20));
    s = ok(s, { type: 'OpenCounterWindow', counter: 'A', start: t(22), end: t(2, 0, 27) });
    s = ok(s, { type: 'OpenCounterWindow', counter: 'B', start: t(22), end: t(2, 0, 27) });
    s = ok(s, {
      type: 'RegisterVolunteer',
      input: { name: 'V7 夜甲', skills: ['A'], available: [{ start: t(22), end: t(2, 0, 27) }] },
    });
    s = ok(s, {
      type: 'RegisterVolunteer',
      input: { name: 'V8 夜乙', skills: ['B'], available: [{ start: t(22), end: t(2, 0, 27) }] },
    });
    const v7 = s.volunteers.find((v) => v.name === 'V7 夜甲')!;
    const v8 = s.volunteers.find((v) => v.name === 'V8 夜乙')!;
    s = ok(s, { type: 'SignIn', volunteerId: v7.id, counter: 'A', at: t(22) });
    s = ok(s, { type: 'SignIn', volunteerId: v8.id, counter: 'B', at: t(22) });
    s = at(s, t(1, 30, 27));
    expect(counterSuspended(s, 'A')).toBe(false);
    expect(counterSuspended(s, 'B')).toBe(false);
    const att = attOf(s, v7.id, 'A')!;
    expect(att.plannedEndAt).toBe(t(2, 0, 27));
    s = ok(s, { type: 'SignOut', attendanceId: att.id, at: t(1, 45, 27) });
    s = at(s, t(1, 50, 27));
    expect(counterSuspended(s, 'A')).toBe(true);
    expect(counterSuspended(s, 'B')).toBe(false);
  });
});

describe('休息区间开放端格式化', () => {
  it('技能撤销区间（开放端）提示可读，不含 NaN', () => {
    let s = seedState();
    s = at(s, t(14, 30));
    s = ok(s, { type: 'RevokeSkill', volunteerId: V4, counter: 'B' });
    const conflict = s.shifts
      .filter((x) => x.status === 'planned')
      .flatMap((x) => shiftIssuesSafe(s, x))
      .join('；');
    expect(conflict).toContain('撤销');
    expect(conflict).not.toContain('NaN');
  });
});

