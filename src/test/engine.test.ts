import { describe, expect, it } from 'vitest';
import {
  CHECKIN_DELAY_REAL_MS,
  applyCommand,
  checkInvariants,
  eligibility,
  openDraftOf,
  roomBuckets,
} from '../engine/engine';
import { seedState } from '../engine/seed';
import type { Command, Role, ShelterState } from '../engine/types';

let cid = 0;
const nid = () => `test-${++cid}`;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type AnyCmd = DistributiveOmit<Command, 'commandId'> & { commandId?: string };

function run(state: ShelterState, cmd: AnyCmd, role: Role = 'receptionist', realNow = 10_000) {
  const full = { ...cmd, commandId: cmd.commandId ?? nid() } as Command;
  return applyCommand(state, full, { role, realNow });
}

/** 断言命令成功并返回新状态 */
function ok(state: ShelterState, cmd: AnyCmd, role: Role = 'receptionist', realNow = 10_000): ShelterState {
  const out = run(state, cmd, role, realNow);
  if (out.error) throw new Error(`命令意外失败: ${out.error}`);
  return out.state;
}

function fail(state: ShelterState, cmd: AnyCmd, role: Role = 'receptionist', realNow = 10_000): string {
  const out = run(state, cmd, role, realNow);
  if (!out.error) throw new Error('命令意外成功');
  return out.error;
}

const T0 = new Date('2026-11-26T15:00:00').getTime();
const T18 = new Date('2026-11-26T18:00:00').getTime();

function expectInvariantsOk(state: ShelterState) {
  const bad = checkInvariants(state).filter((r) => !r.ok);
  expect(bad.map((b) => `${b.name}: ${b.detail}`)).toEqual([]);
}

describe('种子数据对应题目示例', () => {
  it('A/B 各 6 床，A 无障碍，B 已有 2 人实际入住', () => {
    const s = seedState();
    const a = roomBuckets(s, 'room-A');
    const b = roomBuckets(s, 'room-B');
    expect(a).toMatchObject({ capacity: 6, present: 4, allocatable: 2 });
    expect(b).toMatchObject({ capacity: 6, present: 2, allocatable: 4 });
    expect(s.rooms.find((r) => r.id === 'room-A')?.accessible).toBe(true);
    expect(s.rooms.find((r) => r.id === 'room-B')?.accessible).toBe(false);
    expectInvariantsOk(s);
  });

  it('三人无障碍家庭初始无法安置，原因可解释', () => {
    const s = seedState();
    const zhao = s.families.find((f) => f.id === 'fam-zhao')!;
    const roomA = s.rooms.find((r) => r.id === 'room-A')!;
    const roomB = s.rooms.find((r) => r.id === 'room-B')!;
    expect(eligibility(s, zhao, roomA).join()).toContain('可分配2床 < 3人');
    expect(eligibility(s, zhao, roomB).join()).toContain('需要无障碍');
  });
});

describe('路径一：原房原床保留', () => {
  it('保留 A 四床时余下 2 床不足接待新人；按时返所后回到原房', () => {
    let s = seedState();
    s = ok(s, { type: 'RegisterLeave', familyId: 'fam-li', strategy: 'keep_room', expectedReturnAt: T18 });
    // A：在场 0、保护 4、可分配 2
    expect(roomBuckets(s, 'room-A')).toMatchObject({ present: 0, protected: 4, allocatable: 2 });
    // 赵敏一家（3人需无障碍）仍无法安置
    const zhao = s.families.find((f) => f.id === 'fam-zhao')!;
    expect(eligibility(s, zhao, s.rooms[0]).join()).toContain('可分配2床 < 3人');
    // 实际在场人数减少，但住宿关系未结束
    expect(s.families.find((f) => f.id === 'fam-li')?.status).toBe('temp_leave');
    expectInvariantsOk(s);
    // 按时返所
    s = ok(s, { type: 'ConfirmReturn', familyId: 'fam-li' });
    expect(roomBuckets(s, 'room-A')).toMatchObject({ present: 4, protected: 0 });
    expect(s.families.find((f) => f.id === 'fam-li')).toMatchObject({ status: 'checked_in', currentRoomId: 'room-A' });
    expect(s.promises.find((p) => p.familyId === 'fam-li')?.status).toBe('fulfilled');
    expectInvariantsOk(s);
  });
});

describe('路径二：容量保护（返所换房）', () => {
  it('保护 B 四床可将新人安置 A；返所时安排到 B 并说明新房', () => {
    let s = seedState();
    s = ok(s, {
      type: 'RegisterLeave',
      familyId: 'fam-li',
      strategy: 'capacity',
      protectionRoomId: 'room-B',
      expectedReturnAt: T18,
    });
    // A 完全释放，B：在场2 + 保护4
    expect(roomBuckets(s, 'room-A')).toMatchObject({ present: 0, protected: 0, allocatable: 6 });
    expect(roomBuckets(s, 'room-B')).toMatchObject({ present: 2, protected: 4, allocatable: 0 });
    // 赵敏一家入住 A：草稿不占床 → 提交 → 确认中预占 → 结算后计入在场
    s = ok(s, { type: 'CreateDraft', familyId: 'fam-zhao', roomId: 'room-A' });
    expect(roomBuckets(s, 'room-A').allocatable).toBe(6); // 草稿不占床
    expect(roomBuckets(s, 'room-A').drafts).toBe(3);
    const draftId = openDraftOf(s, 'fam-zhao')!.id;
    s = ok(s, { type: 'SubmitCheckIn', assignmentId: draftId }, 'receptionist', 1_000);
    expect(roomBuckets(s, 'room-A')).toMatchObject({ present: 0, confirming: 3, allocatable: 3 });
    s = ok(s, { type: 'FinalizeDue' }, 'receptionist', 1_000 + CHECKIN_DELAY_REAL_MS + 1);
    expect(roomBuckets(s, 'room-A')).toMatchObject({ present: 3, confirming: 0, allocatable: 3 });
    expectInvariantsOk(s);
    // 李强一家返所 → 安排到 B 房，回执包含换房说明
    const out = run(s, { type: 'ConfirmReturn', familyId: 'fam-li' });
    expect(out.error).toBeUndefined();
    s = out.state;
    expect(s.families.find((f) => f.id === 'fam-li')).toMatchObject({ status: 'checked_in', currentRoomId: 'room-B' });
    expect(roomBuckets(s, 'room-B')).toMatchObject({ present: 6, protected: 0 });
    const receipt = out.receipts.find((r) => r.kind === 'return_confirmed')!;
    expect(receipt.lines.join()).toContain('返所换房说明');
    expect(receipt.lines.join()).toContain('说明新房');
    expectInvariantsOk(s);
  });

  it('未同意返所换房的家庭不能用容量保护', () => {
    let s = seedState();
    // 王芳与女儿同意换房，先改成不同意来验证拦截？直接用命令层校验：构造未同意家庭
    s = ok(s, {
      type: 'RegisterFamily',
      input: { name: '测试家庭', size: 2, needsAccessible: false, coRoomConsent: true, consentRoomChange: false },
    });
    const fam = s.families.find((f) => f.name === '测试家庭')!;
    s = ok(s, { type: 'CreateDraft', familyId: fam.id, roomId: 'room-B' });
    const draftId = openDraftOf(s, fam.id)!.id;
    s = ok(s, { type: 'SubmitCheckIn', assignmentId: draftId }, 'receptionist', 100);
    s = ok(s, { type: 'FinalizeDue' }, 'receptionist', 100 + CHECKIN_DELAY_REAL_MS + 1);
    const err = fail(s, {
      type: 'RegisterLeave',
      familyId: fam.id,
      strategy: 'capacity',
      protectionRoomId: 'room-A',
      expectedReturnAt: T18,
    });
    expect(err).toContain('未事先同意返所换房');
  });
});

describe('重复暂离回执（幂等）', () => {
  it('相同 commandId 重发只生效一次并给出重复回执', () => {
    let s = seedState();
    const cmd = {
      type: 'RegisterLeave',
      commandId: 'leave-cmd-1',
      familyId: 'fam-li',
      strategy: 'keep_room',
      expectedReturnAt: T18,
    } as const;
    const first = run(s, cmd);
    expect(first.error).toBeUndefined();
    s = first.state;
    const second = run(s, cmd);
    expect(second.error).toBeUndefined();
    s = second.state;
    // 只有一条承诺、一次床位保护
    expect(s.promises.filter((p) => p.familyId === 'fam-li' && p.status === 'active')).toHaveLength(1);
    expect(roomBuckets(s, 'room-A').protected).toBe(4);
    // 重复回执可见
    const dup = second.receipts.find((r) => r.kind === 'duplicate_submission');
    expect(dup).toBeTruthy();
    expect(dup!.summary).toContain('重复提交');
    expectInvariantsOk(s);
  });
});

describe('承诺到期未归', () => {
  it('只产生联系核实任务，不自动退住，床位继续保护', () => {
    let s = seedState();
    s = ok(s, { type: 'RegisterLeave', familyId: 'fam-li', strategy: 'keep_room', expectedReturnAt: T18 });
    s = ok(s, { type: 'AdvanceClock', toVirtual: new Date('2026-11-26T18:05:00').getTime() });
    const fam = s.families.find((f) => f.id === 'fam-li')!;
    expect(fam.status).toBe('temp_leave'); // 未自动退住
    expect(s.promises.find((p) => p.familyId === 'fam-li')?.status).toBe('expired_contact');
    expect(roomBuckets(s, 'room-A').protected).toBe(4); // 床位继续保护
    const task = s.contactTasks.find((t) => t.familyId === 'fam-li');
    expect(task?.status).toBe('open');
    expectInvariantsOk(s);
    // 值班员延期 → 承诺恢复有效，任务解决
    s = ok(s, { type: 'ExtendPromise', familyId: 'fam-li', newExpectedReturnAt: new Date('2026-11-26T19:00:00').getTime() }, 'duty');
    expect(s.promises.find((p) => p.familyId === 'fam-li')?.status).toBe('active');
    expect(s.contactTasks.find((t) => t.familyId === 'fam-li')?.status).toBe('resolved');
    expectInvariantsOk(s);
  });
});

describe('核实退住', () => {
  it('值班员核实后结束返所权并释放床位；接待员无权办理', () => {
    let s = seedState();
    s = ok(s, { type: 'RegisterLeave', familyId: 'fam-li', strategy: 'keep_room', expectedReturnAt: T18 });
    const errRole = fail(s, { type: 'SubmitCheckout', familyId: 'fam-li' }, 'receptionist');
    expect(errRole).toContain('无权');
    s = ok(s, { type: 'SubmitCheckout', familyId: 'fam-li' }, 'duty', 500);
    s = ok(s, { type: 'FinalizeDue' }, 'duty', 500 + 2_000);
    expect(s.families.find((f) => f.id === 'fam-li')?.status).toBe('checked_out');
    expect(s.promises.find((p) => p.familyId === 'fam-li')?.status).toBe('cancelled');
    expect(roomBuckets(s, 'room-A')).toMatchObject({ present: 0, protected: 0, allocatable: 6 });
    // 返所权已结束
    fail(s, { type: 'ConfirmReturn', familyId: 'fam-li' });
    expectInvariantsOk(s);
  });
});

describe('并发分房（两个标签顺序提交等价于同时）', () => {
  it('后到的提交在事务重核中失败，失效草稿保留输入并说明冲突', () => {
    let s = seedState();
    // 李强暂离（容量保护→B），赵敏入住 A → A 余 3 床
    s = ok(s, { type: 'RegisterLeave', familyId: 'fam-li', strategy: 'capacity', protectionRoomId: 'room-B', expectedReturnAt: T18 });
    s = ok(s, { type: 'CreateDraft', familyId: 'fam-zhao', roomId: 'room-A' });
    s = ok(s, { type: 'SubmitCheckIn', assignmentId: openDraftOf(s, 'fam-zhao')!.id }, 'receptionist', 100);
    s = ok(s, { type: 'FinalizeDue' }, 'receptionist', 100 + CHECKIN_DELAY_REAL_MS + 1);
    expect(roomBuckets(s, 'room-A').allocatable).toBe(3);
    // 标签1：吴磊草稿 A；标签2：新家庭周洁草稿 A（草稿都不占床，均可创建）
    s = ok(s, { type: 'RegisterFamily', input: { name: '周洁一家', size: 3, needsAccessible: false, coRoomConsent: true, consentRoomChange: true } });
    const zhou = s.families.find((f) => f.name === '周洁一家')!;
    s = ok(s, { type: 'CreateDraft', familyId: 'fam-wu', roomId: 'room-A' });
    s = ok(s, { type: 'CreateDraft', familyId: zhou.id, roomId: 'room-A' });
    // 标签1 先提交入住确认 → 确认中预占 3 床，周洁的草稿被事务重核标记失效
    s = ok(s, { type: 'SubmitCheckIn', assignmentId: openDraftOf(s, 'fam-wu')!.id }, 'receptionist', 200);
    const zhouDraft = s.assignments.find((a) => a.familyId === zhou.id && a.kind === 'draft')!;
    expect(zhouDraft.status).toBe('draft_stale');
    expect(zhouDraft.conflictReason).toContain('可分配');
    // 标签2 再提交 → 失败并保留输入
    const err = fail(s, { type: 'SubmitCheckIn', assignmentId: zhouDraft.id }, 'receptionist', 300);
    expect(err).toContain('草稿已失效');
    // 吴磊确认完成，A 满员
    s = ok(s, { type: 'FinalizeDue' }, 'receptionist', 200 + CHECKIN_DELAY_REAL_MS + 1);
    expect(roomBuckets(s, 'room-A')).toMatchObject({ present: 6, allocatable: 0 });
    expectInvariantsOk(s);
  });
});

describe('保护房间临时关闭', () => {
  it('有在场家庭或原房保留承诺时拒绝关闭', () => {
    let s = seedState();
    // B 有王芳在场 → 拒绝
    const err1 = fail(s, { type: 'CloseRoom', roomId: 'room-B', reason: '消杀' }, 'bed_manager');
    expect(err1).toContain('不得被自动搬走');
    // A 有原房保留承诺 → 拒绝
    s = ok(s, { type: 'RegisterLeave', familyId: 'fam-li', strategy: 'keep_room', expectedReturnAt: T18 });
    const err2 = fail(s, { type: 'CloseRoom', roomId: 'room-A', reason: '消杀' }, 'bed_manager');
    expect(err2).toContain('原房原床');
  });

  it('容量保护可整组迁移时允许关闭，否则拒绝', () => {
    let s = seedState();
    // 李强容量保护→B；王芳退住 → B 只剩保护 4 床
    s = ok(s, { type: 'RegisterLeave', familyId: 'fam-li', strategy: 'capacity', protectionRoomId: 'room-B', expectedReturnAt: T18 });
    s = ok(s, { type: 'SubmitCheckout', familyId: 'fam-wang' }, 'duty', 100);
    s = ok(s, { type: 'FinalizeDue' }, 'duty', 100 + 2_000);
    expect(roomBuckets(s, 'room-B')).toMatchObject({ present: 0, protected: 4 });
    // 情形一：赵敏先入住 A（A 余 3 床 < 4）→ 关闭 B 失败
    let s1 = ok(s, { type: 'CreateDraft', familyId: 'fam-zhao', roomId: 'room-A' });
    s1 = ok(s1, { type: 'SubmitCheckIn', assignmentId: openDraftOf(s1, 'fam-zhao')!.id }, 'receptionist', 200);
    s1 = ok(s1, { type: 'FinalizeDue' }, 'receptionist', 200 + CHECKIN_DELAY_REAL_MS + 1);
    const err = fail(s1, { type: 'CloseRoom', roomId: 'room-B', reason: '消杀' }, 'bed_manager');
    expect(err).toContain('无法整组兑现');
    expect(s1.rooms.find((r) => r.id === 'room-B')?.status).toBe('open');
    // 情形二：A 空着 → 关闭 B 成功，保护迁移到 A
    const out = run(s, { type: 'CloseRoom', roomId: 'room-B', reason: '消杀' }, 'bed_manager');
    expect(out.error).toBeUndefined();
    const s2 = out.state;
    expect(s2.rooms.find((r) => r.id === 'room-B')?.status).toBe('closed');
    const p = s2.promises.find((x) => x.familyId === 'fam-li')!;
    expect(p.roomId).toBe('room-A');
    expect(roomBuckets(s2, 'room-A').protected).toBe(4);
    expect(out.receipts.find((r) => r.kind === 'room_closed')!.lines.join()).toContain('迁移');
    expectInvariantsOk(s2);
    // 李强返所 → 安排到迁移后的 A 房，并提示说明新房
    const out2 = run(s2, { type: 'ConfirmReturn', familyId: 'fam-li' });
    expect(out2.error).toBeUndefined();
    expect(out2.state.families.find((f) => f.id === 'fam-li')?.currentRoomId).toBe('room-A');
    expectInvariantsOk(out2.state);
  });
});

describe('共房同意与草稿口径', () => {
  it('未同意共房的家庭不能进入已有家庭的房间', () => {
    const s = seedState();
    const err = fail(s, { type: 'CreateDraft', familyId: 'fam-chen', roomId: 'room-B' });
    expect(err).toContain('未同意共房');
  });

  it('草稿不占正式床位', () => {
    let s = seedState();
    const before = roomBuckets(s, 'room-B');
    s = ok(s, { type: 'CreateDraft', familyId: 'fam-wu', roomId: 'room-B' });
    const after = roomBuckets(s, 'room-B');
    expect(after.allocatable).toBe(before.allocatable);
    expect(after.drafts).toBe(3);
    expectInvariantsOk(s);
  });
});

describe('完整场景串联', () => {
  it('暂离→新人入住→按时返所→退住，全程不变量成立', () => {
    let s = seedState();
    s = ok(s, { type: 'RegisterLeave', familyId: 'fam-li', strategy: 'capacity', protectionRoomId: 'room-B', expectedReturnAt: T18 });
    s = ok(s, { type: 'CreateDraft', familyId: 'fam-zhao', roomId: 'room-A' });
    s = ok(s, { type: 'SubmitCheckIn', assignmentId: openDraftOf(s, 'fam-zhao')!.id }, 'receptionist', 1000);
    s = ok(s, { type: 'FinalizeDue' }, 'receptionist', 1000 + CHECKIN_DELAY_REAL_MS + 1);
    s = ok(s, { type: 'AdvanceClock', toVirtual: new Date('2026-11-26T17:30:00').getTime() });
    s = ok(s, { type: 'ConfirmReturn', familyId: 'fam-li' });
    s = ok(s, { type: 'SubmitCheckout', familyId: 'fam-wang' }, 'duty', 2000);
    s = ok(s, { type: 'FinalizeDue' }, 'duty', 2000 + 2_000);
    expect(roomBuckets(s, 'room-A')).toMatchObject({ present: 3 });
    expect(roomBuckets(s, 'room-B')).toMatchObject({ present: 4 });
    expectInvariantsOk(s);
  });
});
