import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { seedState } from '../engine/seed';
import { applyCommand } from '../engine/engine';
import {
  AttendancePanel,
  BookingsPanel,
  CoveragePanel,
  HandoverPanel,
  RosterPanel,
  MyShiftPanel,
  VolunteersPanel,
} from '../ui/roster';
import { InvariantsPanel, ReceiptsPanel } from '../ui/components';
import type { Command, CmdCtx } from '../engine/types';

const noop = () => {};
const t = (h: number, m = 0) => new Date(2026, 10, 26, h, m, 0).getTime();

function withState(cmd: Command, role: CmdCtx['role'] = 'coordinator') {
  let s = seedState();
  s = applyCommand(s, { type: 'AdvanceClock', toVirtual: t(14, 30), commandId: 'c1' }, { role: 'coordinator', realNow: 1 }).state;
  const out = applyCommand(s, cmd, { role, realNow: 1 });
  return out.state;
}

describe('柜台页可 SSR 渲染（无运行时错误）', () => {
  it('初始态各面板渲染成功', () => {
    const s = seedState();
    const html = renderToString(
      <div>
        <CoveragePanel state={s} />
        <RosterPanel state={s} role="coordinator" onGenerate={noop} onManual={noop} onCancelShift={noop} onSignInShift={noop} onOpenWindow={noop} />
        <AttendancePanel state={s} role="coordinator" volunteerId="vol-zheng" onSignIn={noop} onSignOut={noop} />
        <HandoverPanel state={s} role="coordinator" onRequest={noop} onConfirm={noop} onCancel={noop} />
        <VolunteersPanel state={s} role="coordinator" onRegister={noop} onBlock={noop} onRevoke={noop} onRestore={noop} />
        <BookingsPanel state={s} role="coordinator" onCreate={noop} onReschedule={noop} onCancel={noop} onServe={noop} />
        <InvariantsPanel state={s} />
        <ReceiptsPanel receipts={s.receipts} />
      </div>,
    );
    expect(html).toContain('柜台覆盖');
    expect(html).toContain('计划覆盖');
    expect(html).toContain('实际覆盖');
    expect(html).toContain('受影响预约');
    expect(html).toContain('待确认接班');
  });

  it('B 离岗并发出待确认交接后，页面显示暂停放号与受影响预约', () => {
    let s = seedState();
    s = applyCommand(s, { type: 'AdvanceClock', toVirtual: t(14, 30), commandId: 'u1' }, { role: 'coordinator', realNow: 1 }).state;
    s = applyCommand(s, { type: 'SignOut', commandId: 'u2', attendanceId: 'att-sun-b', at: t(14, 30) }, { role: 'coordinator', realNow: 1 }).state;
    // V2 仍在 A 在岗：直接替补交接允许发起，确认时会被拒绝（页面显示待确认/暂停放号）
    s = applyCommand(s, { type: 'RequestHandover', commandId: 'u3', counter: 'B', toVolunteerId: 'vol-zheng', linkedSwap: false }, { role: 'coordinator', realNow: 1 }).state;
    const html = renderToString(<CoveragePanel state={s} />);
    expect(html).toContain('待确认接班');
    expect(html).toContain('暂停放号');
  });
});

describe('志愿者视角与受影响状态可渲染', () => {
  it('志愿者本人班次面板渲染；撤销技能后显示已撤销', () => {
    let s = seedState();
    s = applyCommand(s, { type: 'AdvanceClock', toVirtual: t(14, 20), commandId: 'v1' }, { role: 'coordinator', realNow: 1 }).state;
    s = applyCommand(s, { type: 'RevokeSkill', commandId: 'v2', volunteerId: 'vol-sun', counter: 'B' }, { role: 'coordinator', realNow: 1 }).state;
    const html = renderToString(
      <div>
        <MyShiftPanel state={s} volunteer={s.volunteers.find((v) => v.id === 'vol-zheng')!} onSignIn={noop} onSignOut={noop} />
        <VolunteersPanel state={s} role="coordinator" onRegister={noop} onBlock={noop} onRevoke={noop} onRestore={noop} />
        <BookingsPanel state={s} role="receptionist" onCreate={noop} onReschedule={noop} onCancel={noop} onServe={noop} />
      </div>,
    );
    expect(html).toContain('我的班次');
    expect(html).toContain('已撤销');
    expect(html).toContain('等待·不可办理');
  });
});
