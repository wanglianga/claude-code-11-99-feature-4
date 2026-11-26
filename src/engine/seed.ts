import type { ShelterState } from './types';

/**
 * 虚构演示数据，同时承载两组题目示例：
 *
 * 床位侧：
 * - A 房 6 床，有无障碍设施；B 房 6 床，普通房，已有 2 人实际入住（王芳与女儿）
 * - 李强一家 4 人住 A 房，不需无障碍，已同意返所换房（稍后将暂离至 18:00）
 * - 赵敏一家 3 人需要无障碍，已到达待安置
 * - 陈伟 2 人不同意共房、吴磊一家 3 人，用于演示共房同意与并发分房
 *
 * 柜台侧（题目样例）：
 * - 接待柜台A、物资柜台B 在 14:00–16:00 连续开放（另设 22:00–次日02:00 跨日窗口用于验证跨日班次）
 * - V1 刘晨：仅 A 技能，可用 14:00–15:00
 * - V3 何静：仅 B 技能，可用 15:00–16:00
 * - V2 郑凯、V4 孙涛：两岗技能齐全，全程可用
 * - 初始采用「固定跨技能守台」：V2 守 A、V4 守 B，并已在 14:00 正常签到
 * - 预约：A 14:10–14:30；B 14:40–15:00；B 15:10–15:30（覆盖此刻的实际在岗）
 */
export function seedState(): ShelterState {
  const virtualNow = new Date('2026-11-26T14:00:00').getTime();
  const t = (h: number, m = 0, dayOffset = 0) =>
    new Date(2026, 10, 26 + dayOffset, h, m, 0).getTime();

  const v1 = 'vol-liu';
  const v2 = 'vol-zheng';
  const v3 = 'vol-he';
  const v4 = 'vol-sun';

  const planId = 'plan-fixed';

  return {
    version: 1,
    virtualNow,
    rooms: [
      { id: 'room-A', name: 'A', capacity: 6, accessible: true, status: 'open' },
      { id: 'room-B', name: 'B', capacity: 6, accessible: false, status: 'open' },
    ],
    families: [
      {
        id: 'fam-wang',
        name: '王芳与女儿',
        size: 2,
        needsAccessible: false,
        coRoomConsent: true,
        consentRoomChange: true,
        status: 'checked_in',
        currentRoomId: 'room-B',
      },
      {
        id: 'fam-li',
        name: '李强一家',
        size: 4,
        needsAccessible: false,
        coRoomConsent: true,
        consentRoomChange: true,
        status: 'checked_in',
        currentRoomId: 'room-A',
      },
      {
        id: 'fam-zhao',
        name: '赵敏一家',
        size: 3,
        needsAccessible: true,
        coRoomConsent: true,
        consentRoomChange: false,
        status: 'registered',
      },
      {
        id: 'fam-chen',
        name: '陈伟',
        size: 2,
        needsAccessible: false,
        coRoomConsent: false,
        consentRoomChange: false,
        status: 'registered',
      },
      {
        id: 'fam-wu',
        name: '吴磊一家',
        size: 3,
        needsAccessible: false,
        coRoomConsent: true,
        consentRoomChange: true,
        status: 'registered',
      },
    ],
    assignments: [
      {
        id: 'as-wang',
        familyId: 'fam-wang',
        roomId: 'room-B',
        beds: 2,
        kind: 'checkin',
        status: 'active',
        createdAt: virtualNow - 3 * 3600_000,
        confirmedAt: virtualNow - 3 * 3600_000,
      },
      {
        id: 'as-li',
        familyId: 'fam-li',
        roomId: 'room-A',
        beds: 4,
        kind: 'checkin',
        status: 'active',
        createdAt: virtualNow - 2 * 3600_000,
        confirmedAt: virtualNow - 2 * 3600_000,
      },
    ],
    promises: [],
    contactTasks: [],
    receipts: [
      {
        seq: 1,
        id: 'R1',
        at: virtualNow,
        kind: 'seed',
        actor: '系统',
        summary: '演示数据已就绪（虚构家庭、房间与志愿者，全部数据仅保存在本浏览器）',
        lines: [
          'A 房 6 床（无障碍）；B 房 6 床（普通房）',
          '王芳与女儿 2 人在住 B 房；李强一家 4 人在住 A 房；赵敏一家 3 人需无障碍，等待安置',
          '柜台A/B 今日 14:00–16:00 连续开放；初始班表为固定守台：V2 郑凯守 A、V4 孙涛守 B（均已在 14:00 签到）',
          'V1 刘晨仅 A 技能可用 14:00–15:00；V3 何静仅 B 技能可用 15:00–16:00；V2/V4 两岗技能齐全',
          '演示时间 14:00，可用右上角按钮推进时间',
        ],
      },
    ],
    pending: [],
    commandLog: [],
    seqCounter: 1,

    // ---- 柜台排班与开台 ----
    counters: [
      {
        id: 'A',
        name: '接待柜台A',
        windows: [{ start: t(14), end: t(16) }],
      },
      {
        id: 'B',
        name: '物资柜台B',
        windows: [{ start: t(14), end: t(16) }],
      },
    ],
    volunteers: [
      { id: v1, name: 'V1 刘晨', skills: ['A'], available: [{ start: t(14), end: t(15) }] },
      { id: v2, name: 'V2 郑凯', skills: ['A', 'B'], available: [{ start: t(14), end: t(16) }] },
      { id: v3, name: 'V3 何静', skills: ['B'], available: [{ start: t(15), end: t(16) }] },
      { id: v4, name: 'V4 孙涛', skills: ['A', 'B'], available: [{ start: t(14), end: t(16) }] },
    ],
    blocks: [],
    skillRevocations: [],
    plans: [
      {
        id: planId,
        strategy: 'fixed_crossskilled',
        windowStart: t(14),
        windowEnd: t(16),
        createdAt: virtualNow,
        status: 'active',
      },
    ],
    shifts: [
      {
        id: 'shift-fixed-a',
        volunteerId: v2,
        counter: 'A',
        start: t(14),
        end: t(16),
        kind: 'main',
        planId,
        status: 'planned',
      },
      {
        id: 'shift-fixed-b',
        volunteerId: v4,
        counter: 'B',
        start: t(14),
        end: t(16),
        kind: 'main',
        planId,
        status: 'planned',
      },
    ],
    attendances: [
      {
        id: 'att-zheng-a',
        volunteerId: v2,
        counter: 'A',
        signedInAt: t(14),
        plannedEndAt: t(16),
        shiftId: 'shift-fixed-a',
      },
      {
        id: 'att-sun-b',
        volunteerId: v4,
        counter: 'B',
        signedInAt: t(14),
        plannedEndAt: t(16),
        shiftId: 'shift-fixed-b',
      },
    ],
    handovers: [],
    bookings: [
      {
        id: 'bk-a-1',
        counter: 'A',
        slotStart: t(14, 10),
        slotEnd: t(14, 30),
        residentRef: 'A-201 周阿姨',
        status: 'booked',
      },
      {
        id: 'bk-b-1',
        counter: 'B',
        slotStart: t(14, 40),
        slotEnd: t(15),
        residentRef: 'C-101 陈先生',
        status: 'booked',
      },
      {
        id: 'bk-b-2',
        counter: 'B',
        slotStart: t(15, 10),
        slotEnd: t(15, 30),
        residentRef: 'C-104 李奶奶',
        status: 'booked',
      },
    ],
  };
}
