import { useEffect, useMemo, useState } from 'react';
import { activePromiseOf } from '../engine/engine';
import { fmtDateTime } from '../engine/format';
import { COUNTER_FULL_NAME } from '../engine/roster';
import type { Command, CounterId, ProtectionStrategy, Role, ShelterState } from '../engine/types';
import { WorkerClient } from './client';
import {
  DraftPanel,
  FamilyList,
  InvariantsPanel,
  LeavePanel,
  NewFamilyForm,
  PendingPlacementPanel,
  ReceiptsPanel,
  ROLE_LABEL,
  RoomCard,
  TasksPanel,
} from './components';
import {
  AttendancePanel,
  BookingsPanel,
  CoveragePanel,
  HandoverPanel,
  MyShiftPanel,
  RosterPanel,
  VolunteersPanel,
} from './roster';

const ROLES: Role[] = ['receptionist', 'duty', 'bed_manager', 'coordinator', 'volunteer'];
type Tab = 'bed' | 'counter';

export default function App() {
  const [client] = useState(() => new WorkerClient());
  const [state, setState] = useState<ShelterState | null>(null);
  const [tab, setTab] = useState<Tab>(() => (localStorage.getItem('shelter-tab') === 'counter' ? 'counter' : 'bed'));
  const [role, setRole] = useState<Role>(() => {
    const saved = localStorage.getItem('shelter-role');
    return saved && ROLES.includes(saved as Role) ? (saved as Role) : 'receptionist';
  });
  const [volunteerId, setVolunteerId] = useState<string>(() => localStorage.getItem('shelter-volunteer') ?? 'vol-zheng');
  const [error, setError] = useState<string | null>(null);
  const [draftFor, setDraftFor] = useState<string | null>(null);
  const [leaveFor, setLeaveFor] = useState<string | null>(null);
  /** 每个家庭最近一次暂离命令（用于演示“重复暂离回执”的幂等） */
  const [lastLeaveCmd, setLastLeaveCmd] = useState<Record<string, Command>>({});
  const [tabId] = useState(() => Math.random().toString(36).slice(2, 6).toUpperCase());

  useEffect(() => {
    client.onState(setState);
    void client.refreshState();
  }, [client]);

  const run = async (cmd: Command): Promise<boolean> => {
    const r = await client.cmd(cmd, role, role === 'volunteer' ? volunteerId : undefined);
    if (!r.ok && r.error) setError(r.error);
    else setError(null);
    await client.refreshState();
    return r.ok;
  };

  const newCmd = <T extends Omit<Command, 'commandId'>>(cmd: T): Command => ({
    ...cmd,
    commandId: crypto.randomUUID(),
  }) as Command;

  const handlers = useMemo(
    () => ({
      onStartDraft: (familyId: string) => {
        setLeaveFor(null);
        setDraftFor(familyId);
      },
      onCancelDraft: (assignmentId: string) => void run(newCmd({ type: 'CancelDraft', assignmentId })),
      onSubmitCheckIn: (assignmentId: string) => void run(newCmd({ type: 'SubmitCheckIn', assignmentId })),
      onStartLeave: (familyId: string) => {
        setDraftFor(null);
        setLeaveFor(familyId);
      },
      onReturn: (familyId: string) => void run(newCmd({ type: 'ConfirmReturn', familyId })),
      onExtend: (familyId: string) => {
        if (!state) return;
        const p = activePromiseOf(state, familyId);
        if (!p) return;
        const base = Math.max(p.expectedReturnAt, state.virtualNow);
        void run(newCmd({ type: 'ExtendPromise', familyId, newExpectedReturnAt: base + 3600_000 }));
      },
      onCheckout: (familyId: string) => void run(newCmd({ type: 'SubmitCheckout', familyId })),
      onRetryStale: (familyId: string, roomId: string) => void run(newCmd({ type: 'CreateDraft', familyId, roomId })),
      onDuplicateLeave: (familyId: string) => {
        const cmd = lastLeaveCmd[familyId];
        if (cmd) void run(cmd); // 相同 commandId 重发 → 幂等重复回执
      },
      canDuplicateLeave: (familyId: string) => !!lastLeaveCmd[familyId],
    }),
    [state, role, lastLeaveCmd],
  );

  if (!state) return <div className="loading">正在加载本地数据…</div>;

  const draftFamily = draftFor ? state.families.find((f) => f.id === draftFor) : null;
  const leaveFamily = leaveFor ? state.families.find((f) => f.id === leaveFor) : null;
  const volunteer = state.volunteers.find((v) => v.id === volunteerId) ?? state.volunteers[0];

  return (
    <div className="app">
      <header className="topbar">
        <div className="title">避难所入住返所 · 柜台排班开台工作台</div>
        <label className="role-select">
          当前角色：
          <select
            value={role}
            onChange={(e) => {
              const r = e.target.value as Role;
              setRole(r);
              localStorage.setItem('shelter-role', r);
            }}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        </label>
        {role === 'volunteer' && (
          <label className="role-select">
            本人：
            <select
              value={volunteerId}
              onChange={(e) => {
                setVolunteerId(e.target.value);
                localStorage.setItem('shelter-volunteer', e.target.value);
              }}
            >
              {state.volunteers.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <span className="clock">演示时间：{fmtDateTime(state.virtualNow)}</span>
        <button onClick={() => void run(newCmd({ type: 'AdvanceClock', toVirtual: state.virtualNow + 15 * 60_000 }))}>
          +15分钟
        </button>
        <button onClick={() => void run(newCmd({ type: 'AdvanceClock', toVirtual: state.virtualNow + 3600_000 }))}>
          +1小时
        </button>
        <button
          className="ghost"
          onClick={() => {
            if (window.confirm('重置为初始演示场景？')) void run(newCmd({ type: 'ResetDemo' }));
          }}
        >
          重置演示数据
        </button>
        <span className="tab-badge" title="同一站点多标签页共享 IndexedDB 存储，操作实时同步">
          标签页 #{tabId} · 多标签已同步
        </span>
      </header>

      <nav className="tabbar">
        <button className={tab === 'bed' ? 'tab active' : 'tab'} onClick={() => { setTab('bed'); localStorage.setItem('shelter-tab', 'bed'); }}>
          床位与家庭
        </button>
        <button className={tab === 'counter' ? 'tab active' : 'tab'} onClick={() => { setTab('counter'); localStorage.setItem('shelter-tab', 'counter'); }}>
          柜台排班与开台
        </button>
        {(['A', 'B'] as CounterId[]).map((c) => (
          <span key={c} className="tab-counter">
            {COUNTER_FULL_NAME[c]}
            {state.handovers.some((h) => h.counter === c && h.status === 'pending') && (
              <span className="pulse-dot" title="待确认接班" />
            )}
          </span>
        ))}
      </nav>

      {error && (
        <div className="error-banner" onClick={() => setError(null)}>
          ✗ {error}（点击关闭）
        </div>
      )}

      {tab === 'bed' ? (
        <div className="layout">
          <section className="col">
            <h2>房间看板</h2>
            {state.rooms.map((room) => (
              <RoomCard
                key={room.id}
                state={state}
                room={room}
                role={role}
                onCloseRoom={(roomId) => {
                  const reason = window.prompt('关闭原因', '消杀临时关闭');
                  if (reason !== null) void run(newCmd({ type: 'CloseRoom', roomId, reason: reason || '临时关闭' }));
                }}
                onReopenRoom={(roomId) => void run(newCmd({ type: 'ReopenRoom', roomId }))}
              />
            ))}
            <NewFamilyForm
              role={role}
              onSubmit={(input) => void run(newCmd({ type: 'RegisterFamily', input }))}
            />
          </section>

          <section className="col">
            <h2>家庭与操作</h2>
            {draftFamily && (
              <DraftPanel
                state={state}
                family={draftFamily}
                onCancel={() => setDraftFor(null)}
                onSubmit={(roomId) => {
                  void run(newCmd({ type: 'CreateDraft', familyId: draftFamily.id, roomId })).then((ok) => {
                    if (ok) setDraftFor(null);
                  });
                }}
              />
            )}
            {leaveFamily && (
              <LeavePanel
                state={state}
                family={leaveFamily}
                onCancel={() => setLeaveFor(null)}
                onSubmit={(strategy: ProtectionStrategy, protectionRoomId: string | undefined, hours: number) => {
                  const cmd = newCmd({
                    type: 'RegisterLeave',
                    familyId: leaveFamily.id,
                    strategy,
                    protectionRoomId,
                    expectedReturnAt: state.virtualNow + hours * 3600_000,
                  });
                  void run(cmd).then((ok) => {
                    if (ok) {
                      setLastLeaveCmd((m) => ({ ...m, [leaveFamily.id]: cmd }));
                      setLeaveFor(null);
                    }
                  });
                }}
              />
            )}
            <FamilyList state={state} role={role} h={handlers} />
          </section>

          <section className="col">
            <PendingPlacementPanel state={state} />
            <TasksPanel
              state={state}
              role={role}
              onExtend={handlers.onExtend}
              onCheckout={handlers.onCheckout}
              onNote={(taskId, note) => void run(newCmd({ type: 'AddTaskNote', taskId, note }))}
            />
            <InvariantsPanel state={state} />
            <ReceiptsPanel receipts={state.receipts} />
          </section>
        </div>
      ) : (
        <div className="layout counter-layout">
          <section className="col">
            {role !== 'coordinator' && role !== 'volunteer' && (
              <div className="hint-banner">
                排班、签到、交接等柜台操作需切换到「排班协调员」角色；本页当前为只读/预约视角。
              </div>
            )}
            {role === 'volunteer' && volunteer && (
              <MyShiftPanel
                state={state}
                volunteer={volunteer}
                onSignIn={(counter) => void run(newCmd({ type: 'SignIn', volunteerId: volunteer.id, counter }))}
                onSignOut={(attendanceId) =>
                  void run(newCmd({ type: 'SignOut', attendanceId, at: state.virtualNow }))
                }
              />
            )}
            <CoveragePanel state={state} />
            <BookingsPanel
              state={state}
              role={role}
              onCreate={(counter, start, end, residentRef) =>
                void run(newCmd({ type: 'CreateBooking', counter, slotStart: start, slotEnd: end, residentRef }))
              }
              onReschedule={(bookingId, start, end) =>
                void run(newCmd({ type: 'RescheduleBooking', bookingId, slotStart: start, slotEnd: end }))
              }
              onCancel={(bookingId) => void run(newCmd({ type: 'CancelBooking', bookingId }))}
              onServe={(bookingId) => void run(newCmd({ type: 'ServeBooking', bookingId }))}
            />
          </section>

          <section className="col">
            <RosterPanel
              state={state}
              role={role}
              onGenerate={(strategy, windowStart, windowEnd) =>
                void run(newCmd({ type: 'GenerateRoster', strategy, windowStart, windowEnd }))
              }
              onManual={(vid, counter, start, end) =>
                void run(newCmd({ type: 'ManualAssignShift', volunteerId: vid, counter, start, end }))
              }
              onCancelShift={(shiftId) => void run(newCmd({ type: 'CancelShift', shiftId }))}
              onSignInShift={(vid, counter) => void run(newCmd({ type: 'SignIn', volunteerId: vid, counter }))}
              onOpenWindow={(counter, start, end) => void run(newCmd({ type: 'OpenCounterWindow', counter, start, end }))}
            />
            <AttendancePanel
              state={state}
              role={role}
              volunteerId={volunteer?.id ?? ''}
              onSignIn={(vid, counter, at) => void run(newCmd({ type: 'SignIn', volunteerId: vid, counter, at }))}
              onSignOut={(attendanceId, at, reportedAt) =>
                void run(newCmd({ type: 'SignOut', attendanceId, at, reportedAt }))
              }
            />
            <HandoverPanel
              state={state}
              role={role}
              onRequest={(counter, toVolunteerId, linkedSwap, fillVolunteerId) =>
                void run(newCmd({ type: 'RequestHandover', counter, toVolunteerId, linkedSwap, fillVolunteerId }))
              }
              onConfirm={(handoverId, side) => void run(newCmd({ type: 'ConfirmHandover', handoverId, side }))}
              onCancel={(handoverId) => void run(newCmd({ type: 'CancelHandover', handoverId }))}
            />
          </section>

          <section className="col">
            <VolunteersPanel
              state={state}
              role={role}
              onRegister={(input) => void run(newCmd({ type: 'RegisterVolunteer', input }))}
              onBlock={(input) => void run(newCmd({ type: 'AddVolunteerBlock', ...input }))}
              onRevoke={(vid, counter) => void run(newCmd({ type: 'RevokeSkill', volunteerId: vid, counter }))}
              onRestore={(vid, counter) => void run(newCmd({ type: 'RestoreSkill', volunteerId: vid, counter }))}
            />
            <InvariantsPanel state={state} />
            <ReceiptsPanel receipts={state.receipts} />
          </section>
        </div>
      )}
    </div>
  );
}
