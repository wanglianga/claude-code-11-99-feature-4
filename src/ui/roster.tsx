import { useMemo, useState } from 'react';
import {
  COUNTER_FULL_NAME,
  counterSuspended,
  coverageReport,
  fmtRange,
  fmtSlot,
  mobileReserveAt,
  openAttendanceOf,
  rosterConflicts,
  shiftIssues,
  skillActiveAt,
  volunteerById,
} from '../engine/roster';
import { fmtTime } from '../engine/format';
import type {
  Booking,
  CounterId,
  Interval,
  Role,
  ShelterState,
  Volunteer,
} from '../engine/types';
import { Badge } from './components';

// ---------------------------------------------------------------------------
// 时间输入：以演示日为锚点；结束早于开始视为跨日
// ---------------------------------------------------------------------------

function anchorDate(state: ShelterState): Date {
  const d = new Date(state.virtualNow);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function timeToTs(state: ShelterState, hhmm: string, opts?: { nextDay?: boolean }): number {
  const [h, m] = hhmm.split(':').map(Number);
  const base = anchorDate(state);
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + (opts?.nextDay ? 1 : 0), h || 0, m || 0);
  return d.getTime();
}

/** 结束时间不晚于开始时自动跨日 */
export function rangeFromInputs(state: ShelterState, start: string, end: string): Interval {
  const s = timeToTs(state, start);
  let e = timeToTs(state, end);
  if (e <= s) e = timeToTs(state, end, { nextDay: true });
  return { start: s, end: e };
}

const SKILL_LABEL = (c: CounterId) => (c === 'A' ? 'A 接待' : 'B 物资');

// ---------------------------------------------------------------------------
// 柜台覆盖（计划 / 实际 / 受影响预约 / 待确认接班）
// ---------------------------------------------------------------------------

function CoverageBar({ windows, intervals }: { windows: Interval[]; intervals: Interval[] }) {
  if (windows.length === 0) return <div className="cov-track" />;
  // 以全部窗口的总跨度做比例尺
  const min = Math.min(...windows.map((w) => w.start));
  const max = Math.max(...windows.map((w) => w.end));
  const span = Math.max(1, max - min);
  return (
    <div className="cov-track">
      {windows.map((w) => {
        const left = ((w.start - min) / span) * 100;
        const width = ((w.end - w.start) / span) * 100;
        return (
          <div key={w.start} className="cov-window" style={{ left: `${left}%`, width: `${width}%` }}>
            {intervals
              .filter((i) => i.start < w.end && i.end > w.start)
              .map((i) => {
                const l = ((Math.max(i.start, w.start) - w.start) / (w.end - w.start)) * 100;
                const wd = ((Math.min(i.end, w.end) - Math.max(i.start, w.start)) / (w.end - w.start)) * 100;
                return <div key={i.start} className="cov-fill" style={{ left: `${l}%`, width: `${wd}%` }} />;
              })}
            <span className="cov-window-label">
              {fmtTime(w.start)}–{fmtRange(w).split('–')[1]}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function CoveragePanel({ state }: { state: ShelterState }) {
  const rows = coverageReport(state);
  const nameOf = (id: string) => volunteerById(state, id)?.name ?? id;
  return (
    <div className="card">
      <div className="panel-title">柜台覆盖（计划 vs 实际）</div>
      <div className="muted">
        覆盖一律以实际时间区间检验：名义排班不计入实际，只有签到后的出勤区间才有覆盖。
      </div>
      {rows.map((r) => {
        const suspended = counterSuspended(state, r.counter);
        const planGaps = r.planGaps.flatMap((g) => g.gaps);
        const actualGaps = r.actualGaps.flatMap((g) => g.gaps);
        return (
          <div key={r.counter} className="cov-block">
            <div className="cov-head">
              <b>{r.name}</b>
              {suspended ? <Badge text="暂停放号" tone="red" /> : <Badge text="开放放号" tone="green" />}
              {r.pendingHandoverIds.length > 0 && <Badge text={`待确认接班 ${r.pendingHandoverIds.length}`} tone="orange" />}
            </div>
            <div className="cov-row">
              <span className="cov-label">计划覆盖</span>
              <CoverageBar windows={r.windows} intervals={r.planIntervals} />
              <span className={`cov-note ${planGaps.length ? 'c-bad' : 'c-ok'}`}>
                {planGaps.length ? `缺口 ${planGaps.map(fmtRange).join('、')}` : '连续无缺口'}
              </span>
            </div>
            <div className="cov-row">
              <span className="cov-label">实际覆盖</span>
              <CoverageBar windows={r.windows} intervals={r.actualIntervals} />
              <span className={`cov-note ${actualGaps.length ? 'c-bad' : 'c-ok'}`}>
                {actualGaps.length ? `待补 ${actualGaps.map(fmtRange).join('、')}` : '当前至关闭均有人'}
              </span>
            </div>
            <div className="cov-meta">
              <span>
                在岗：
                {r.onDuty.length
                  ? r.onDuty.map((p) => `${p.name}（至${fmtTime(p.end)}）`).join('、')
                  : '（无人）'}
              </span>
              <span>
                机动：
                {r.mobile.length ? r.mobile.map((m) => m.name).join('、') : '（无跨技能机动）'}
              </span>
            </div>
            <div className="cov-meta">
              <span>
                受影响预约：
                {r.affectedBookingIds.length
                  ? r.affectedBookingIds
                      .map((id) => {
                        const b = state.bookings.find((x) => x.id === id);
                        return b ? `${b.residentRef} ${fmtSlot(b)}` : id;
                      })
                      .join('、')
                  : '（无）'}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 志愿者与资质
// ---------------------------------------------------------------------------

export function VolunteersPanel({
  state,
  role,
  onRegister,
  onBlock,
  onRevoke,
  onRestore,
}: {
  state: ShelterState;
  role: Role;
  onRegister: (input: { name: string; skills: CounterId[]; available: Interval[] }) => void;
  onBlock: (input: { volunteerId: string; kind: 'rest' | 'task'; start: number; end: number; label: string }) => void;
  onRevoke: (volunteerId: string, counter: CounterId) => void;
  onRestore: (volunteerId: string, counter: CounterId) => void;
}) {
  const isCoord = role === 'coordinator';
  const [name, setName] = useState('');
  const [skills, setSkills] = useState<CounterId[]>(['A']);
  const [availStart, setAvailStart] = useState('14:00');
  const [availEnd, setAvailEnd] = useState('16:00');
  const [blockFor, setBlockFor] = useState<string>('');
  const [blockKind, setBlockKind] = useState<'rest' | 'task'>('rest');
  const [blockStart, setBlockStart] = useState('14:30');
  const [blockEnd, setBlockEnd] = useState('15:00');
  const [blockLabel, setBlockLabel] = useState('');

  return (
    <div className="card">
      <div className="panel-title">志愿者与资质</div>
      {state.volunteers.map((v) => {
        const open = openAttendanceOf(state, v.id);
        return (
          <div key={v.id} className="vol-row">
            <div className="vol-head">
              <b>{v.name}</b>
              <span className="badges">
                {(['A', 'B'] as CounterId[]).map((c) =>
                  v.skills.includes(c) ? (
                    <Badge
                      key={c}
                      text={`${SKILL_LABEL(c)}${skillActiveAt(state, v, c, state.virtualNow) ? '' : '·已撤销'}`}
                      tone={skillActiveAt(state, v, c, state.virtualNow) ? 'blue' : 'red'}
                    />
                  ) : null,
                )}
                {open && <Badge text={`在岗 ${COUNTER_FULL_NAME[open.counter]}`} tone="green" />}
              </span>
            </div>
            <div className="muted">可用：{v.available.map(fmtRange).join('、')}</div>
            {state.blocks.filter((b) => b.volunteerId === v.id).map((b) => (
              <div key={b.id} className="muted">
                {b.kind === 'rest' ? '休息' : '临时任务'}「{b.label}」{fmtRange(b)}
              </div>
            ))}
            {isCoord && (
              <div className="row-actions">
                {v.skills.map((c) => (
                  <span key={c}>
                    {skillActiveAt(state, v, c, state.virtualNow) ? (
                      <button className="ghost mini" onClick={() => onRevoke(v.id, c)}>
                        撤销 {SKILL_LABEL(c)} 资格
                      </button>
                    ) : (
                      <button className="ghost mini" onClick={() => onRestore(v.id, c)}>
                        恢复 {SKILL_LABEL(c)} 资格
                      </button>
                    )}
                  </span>
                ))}
                <button className="ghost mini" onClick={() => setBlockFor(blockFor === v.id ? '' : v.id)}>
                  登记休息/任务
                </button>
              </div>
            )}
            {isCoord && blockFor === v.id && (
              <div className="inline-form">
                <select value={blockKind} onChange={(e) => setBlockKind(e.target.value as 'rest' | 'task')}>
                  <option value="rest">休息</option>
                  <option value="task">临时任务</option>
                </select>
                <input type="time" value={blockStart} onChange={(e) => setBlockStart(e.target.value)} />
                <span>–</span>
                <input type="time" value={blockEnd} onChange={(e) => setBlockEnd(e.target.value)} />
                <input
                  placeholder="说明（如 午休 / 搬运物资）"
                  value={blockLabel}
                  onChange={(e) => setBlockLabel(e.target.value)}
                />
                <button
                  className="mini"
                  onClick={() => {
                    const r = rangeFromInputs(state, blockStart, blockEnd);
                    onBlock({ volunteerId: v.id, kind: blockKind, start: r.start, end: r.end, label: blockLabel });
                    setBlockFor('');
                  }}
                >
                  登记区间
                </button>
              </div>
            )}
          </div>
        );
      })}
      {isCoord && (
        <>
          <div className="panel-sub">登记新志愿者</div>
          <div className="inline-form">
            <input value={name} placeholder="姓名（如 V7 周雨）" onChange={(e) => setName(e.target.value)} />
            <label>
              <input
                type="checkbox"
                checked={skills.includes('A')}
                onChange={(e) =>
                  setSkills(e.target.checked ? [...new Set<CounterId>([...skills, 'A'])] : skills.filter((c) => c !== 'A'))
                }
              />{' '}
              A 接待
            </label>
            <label>
              <input
                type="checkbox"
                checked={skills.includes('B')}
                onChange={(e) =>
                  setSkills(e.target.checked ? [...new Set<CounterId>([...skills, 'B'])] : skills.filter((c) => c !== 'B'))
                }
              />{' '}
              B 物资
            </label>
            <input type="time" value={availStart} onChange={(e) => setAvailStart(e.target.value)} />
            <span>–</span>
            <input type="time" value={availEnd} onChange={(e) => setAvailEnd(e.target.value)} />
            <button
              className="mini"
              disabled={!name.trim() || skills.length === 0}
              onClick={() => {
                onRegister({ name, skills, available: [rangeFromInputs(state, availStart, availEnd)] });
                setName('');
              }}
            >
              登记
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 班表：生成 / 手工 / 冲突
// ---------------------------------------------------------------------------

export function RosterPanel({
  state,
  role,
  onGenerate,
  onManual,
  onCancelShift,
  onSignInShift,
  onOpenWindow,
}: {
  state: ShelterState;
  role: Role;
  onGenerate: (strategy: 'fixed_crossskilled' | 'short_shift', windowStart: number, windowEnd: number) => void;
  onManual: (volunteerId: string, counter: CounterId, start: number, end: number) => void;
  onCancelShift: (shiftId: string) => void;
  onSignInShift: (volunteerId: string, counter: CounterId) => void;
  onOpenWindow: (counter: CounterId, start: number, end: number) => void;
}) {
  const isCoord = role === 'coordinator';
  const [winStart, setWinStart] = useState('14:00');
  const [winEnd, setWinEnd] = useState('16:00');
  const [mv, setMv] = useState('');
  const [mc, setMc] = useState<CounterId>('A');
  const [ms, setMs] = useState('14:00');
  const [me, setMe] = useState('16:00');
  const conflicts = useMemo(() => rosterConflicts(state), [state]);
  const shifts = [...state.shifts].filter((s) => s.status === 'planned').sort((a, b) => a.start - b.start || (a.counter < b.counter ? -1 : 1));
  const nameOf = (id: string) => volunteerById(state, id)?.name ?? id;
  const range = rangeFromInputs(state, winStart, winEnd);

  return (
    <div className="card">
      <div className="panel-title">班表（计划排班 ≠ 实际在岗）</div>
      {isCoord && (
        <>
          <div className="inline-form">
            排班窗口
            <input type="time" value={winStart} onChange={(e) => setWinStart(e.target.value)} />
            <span>–</span>
            <input type="time" value={winEnd} onChange={(e) => setWinEnd(e.target.value)} />
            <button className="mini" onClick={() => onGenerate('fixed_crossskilled', range.start, range.end)}>
              生成：固定跨技能守台
            </button>
            <button className="mini" onClick={() => onGenerate('short_shift', range.start, range.end)}>
              生成：短时主班+机动
            </button>
          </div>
          <div className="muted">
            固定守台：交接少、居民容易找到固定人员；短时主班+机动：补临时缺岗快，但接班确认更多。
          </div>
          <div className="inline-form">
            开放柜台窗口（跨日请把结束设为早于开始的时间）
            {(['A', 'B'] as CounterId[]).map((c) => (
              <button
                key={c}
                className="ghost mini"
                onClick={() => onOpenWindow(c, range.start, range.end)}
                title={`按上方窗口为${COUNTER_FULL_NAME[c]}新增开放时间`}
              >
                + {COUNTER_FULL_NAME[c]}
              </button>
            ))}
          </div>
          <div className="inline-form">
            手工排班
            <select value={mv} onChange={(e) => setMv(e.target.value)}>
              <option value="">选择志愿者</option>
              {state.volunteers.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}（{v.skills.join('/')}）
                </option>
              ))}
            </select>
            <select value={mc} onChange={(e) => setMc(e.target.value as CounterId)}>
              <option value="A">接待柜台A</option>
              <option value="B">物资柜台B</option>
            </select>
            <input type="time" value={ms} onChange={(e) => setMs(e.target.value)} />
            <span>–</span>
            <input type="time" value={me} onChange={(e) => setMe(e.target.value)} />
            <button
              className="mini"
              disabled={!mv}
              onClick={() => {
                const r = rangeFromInputs(state, ms, me);
                onManual(mv, mc, r.start, r.end);
              }}
            >
              排入
            </button>
          </div>
        </>
      )}
      <div className="panel-sub">计划班次</div>
      {shifts.length === 0 && <div className="muted">（无计划班次）</div>}
      {shifts.map((s) => {
        const issues = shiftIssues(state, s);
        const on = openAttendanceOf(state, s.volunteerId);
        const signedInHere = on?.counter === s.counter;
        return (
          <div key={s.id} className="shift-row">
            <span>
              {fmtRange(s)} · {COUNTER_FULL_NAME[s.counter]} · <b>{nameOf(s.volunteerId)}</b>{' '}
              <Badge text={s.kind === 'main' ? '主班' : '替休'} tone={s.kind === 'main' ? 'blue' : 'purple'} />
              {signedInHere && <Badge text="已签到" tone="green" />}
            </span>
            {issues.length > 0 && <span className="c-bad">⚠ {issues.join('；')}</span>}
            {(role === 'coordinator' || role === 'volunteer') &&
              !on &&
              s.start <= state.virtualNow + 30 * 60_000 &&
              s.end > state.virtualNow && (
                <button className="mini" onClick={() => onSignInShift(s.volunteerId, s.counter)}>
                  签到
                </button>
              )}
            {isCoord && (
              <button className="ghost mini" onClick={() => onCancelShift(s.id)}>
                取消班次
              </button>
            )}
          </div>
        );
      })}
      <div className="panel-sub">冲突检查（{conflicts.length}）</div>
      {conflicts.length === 0 ? (
        <div className="muted c-ok">✓ 无技能/时间冲突：无跨柜台重复、无休息任务重叠、资质有效</div>
      ) : (
        conflicts.map((c) => (
          <div key={c.shiftId} className="c-bad">
            ✗ {c.message}
          </div>
        ))
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 签到 / 离岗
// ---------------------------------------------------------------------------

export function AttendancePanel({
  state,
  role,
  volunteerId,
  onSignIn,
  onSignOut,
}: {
  state: ShelterState;
  role: Role;
  volunteerId: string;
  onSignIn: (volunteerId: string, counter: CounterId, at?: number) => void;
  onSignOut: (attendanceId: string, at: number, reportedAt?: number) => void;
}) {
  const canSign = role === 'volunteer' || role === 'coordinator';
  const [target, setTarget] = useState('');
  const [counter, setCounter] = useState<CounterId>('A');
  const [lateFor, setLateFor] = useState('');
  const [lateAt, setLateAt] = useState('14:30');
  const [lateReportedAt, setLateReportedAt] = useState('14:55');
  const active = state.attendances.filter((a) => a.signedOutAt === undefined);
  const done = [...state.attendances].filter((a) => a.signedOutAt !== undefined).sort((a, b) => (b.signedOutAt ?? 0) - (a.signedOutAt ?? 0));
  const nameOf = (id: string) => volunteerById(state, id)?.name ?? id;

  return (
    <div className="card">
      <div className="panel-title">签到 / 接班 / 离岗</div>
      {canSign && (
        <div className="inline-form">
          签到
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">{role === 'volunteer' ? '（本人）' : '选择志愿者'}</option>
            {state.volunteers
              .filter((v) => role !== 'volunteer' || v.id === volunteerId)
              .map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
          </select>
          <select value={counter} onChange={(e) => setCounter(e.target.value as CounterId)}>
            <option value="A">接待柜台A</option>
            <option value="B">物资柜台B</option>
          </select>
          <button
            className="mini"
            onClick={() => onSignIn(role === 'volunteer' ? volunteerId : target, counter)}
            disabled={role !== 'volunteer' && !target}
          >
            立即签到（当前演示时间）
          </button>
        </div>
      )}
      <div className="muted">
        签到生成实际出勤；迟到签到（晚于班次开始）自签到时刻起才有实际覆盖。一人同一时刻只能在一个柜台在岗。
      </div>
      <div className="panel-sub">当前在岗（{active.length}）</div>
      {active.length === 0 && <div className="muted">（无人在岗）</div>}
      {active.map((a) => (
        <div key={a.id} className="shift-row">
          <span>
            <b>{nameOf(a.volunteerId)}</b> · {COUNTER_FULL_NAME[a.counter]} · 自 {fmtTime(a.signedInAt)}
            {a.lateSignIn && <Badge text="迟到签到" tone="orange" />}
          </span>
          {canSign && (
            <span className="row-actions">
              <button className="ghost mini" onClick={() => onSignOut(a.id, state.virtualNow)}>
                离岗（现在）
              </button>
              <button className="ghost mini" onClick={() => setLateFor(lateFor === a.id ? '' : a.id)}>
                补录离岗回执
              </button>
            </span>
          )}
          {canSign && lateFor === a.id && (
            <div className="inline-form">
              实际离岗
              <input type="time" value={lateAt} onChange={(e) => setLateAt(e.target.value)} />
              回执到达
              <input type="time" value={lateReportedAt} onChange={(e) => setLateReportedAt(e.target.value)} />
              <button
                className="mini"
                onClick={() => {
                  onSignOut(a.id, timeToTs(state, lateAt), timeToTs(state, lateReportedAt));
                  setLateFor('');
                }}
              >
                提交（按发生时间修订缺岗区间）
              </button>
            </div>
          )}
        </div>
      ))}
      <div className="panel-sub">历史出勤（班表调整不回撤）</div>
      {done.slice(0, 8).map((a) => (
        <div key={a.id} className="muted">
          {nameOf(a.volunteerId)} · {COUNTER_FULL_NAME[a.counter]} · {fmtTime(a.signedInAt)}–{fmtTime(a.signedOutAt!)}
          {a.lateReport && <Badge text="回执晚到·按发生时间" tone="orange" />}
          {a.signOutNote ? ` · ${a.signOutNote}` : ''}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 交接（直接替补 / 联动换岗）
// ---------------------------------------------------------------------------

export function HandoverPanel({
  state,
  role,
  onRequest,
  onConfirm,
  onCancel,
}: {
  state: ShelterState;
  role: Role;
  onRequest: (counter: CounterId, toVolunteerId: string, linkedSwap: boolean, fillVolunteerId?: string) => void;
  onConfirm: (handoverId: string, side: 'outgoing' | 'incoming') => void;
  onCancel: (handoverId: string) => void;
}) {
  const canAct = role === 'coordinator' || role === 'volunteer';
  const [counter, setCounter] = useState<CounterId>('B');
  const [to, setTo] = useState('');
  const [linked, setLinked] = useState(false);
  const [fill, setFill] = useState('');
  const pending = state.handovers.filter((h) => h.status === 'pending');
  const recent = state.handovers
    .filter((h) => h.status !== 'pending')
    .sort((a, b) => (b.effectiveAt ?? b.requestedAt) - (a.effectiveAt ?? a.requestedAt))
    .slice(0, 6);
  const nameOf = (id?: string) => (id ? volunteerById(state, id)?.name ?? id : '（无人）');
  const mobile = mobileReserveAt(state, state.virtualNow);

  return (
    <div className="card">
      <div className="panel-title">交接（待确认接班 {pending.length}）</div>
      {canAct && (
        <>
          <div className="inline-form">
            发起交接
            <select value={counter} onChange={(e) => setCounter(e.target.value as CounterId)}>
              <option value="A">接待柜台A</option>
              <option value="B">物资柜台B</option>
            </select>
            <select value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="">选择接班人</option>
              {state.volunteers.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}（{v.skills.join('/')}）
                </option>
              ))}
            </select>
            <label>
              <input type="checkbox" checked={linked} onChange={(e) => setLinked(e.target.checked)} /> 联动换岗
            </label>
            {linked && (
              <select value={fill} onChange={(e) => setFill(e.target.value)}>
                <option value="">补位人选（原柜台）</option>
                {state.volunteers.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
            )}
            <button
              className="mini"
              disabled={!to || (linked && !fill)}
              onClick={() => {
                onRequest(counter, to, linked, linked ? fill : undefined);
                setTo('');
                setFill('');
              }}
            >
              发起（生效前暂停放号）
            </button>
          </div>
          <div className="muted">
            直接替补：一名可立即上岗者接替。联动换岗：从另一柜台调人过来，并指定补位者接手原柜台。双方确认后只生效一份。
            当前可机动：{mobile.length ? mobile.map((m) => m.name).join('、') : '（无）'}
          </div>
        </>
      )}
      {pending.length === 0 && <div className="muted">（无待确认接班）</div>}
      {pending.map((h) => {
        const suspended = state.handovers.some((x) => x.counter === h.counter && x.status === 'pending');
        return (
          <div key={h.id} className="handover-row">
            <div>
              <b>{COUNTER_FULL_NAME[h.counter]}</b>：{nameOf(h.fromVolunteerId)} → {nameOf(h.toVolunteerId)}
              {h.linkedSwap && <Badge text="联动换岗" tone="purple" />}
              {suspended && <Badge text="暂停放号" tone="red" />}
            </div>
            <div className="muted">{h.note}</div>
            <div className="muted">
              交班方：{h.fromVolunteerId ? (h.outgoingConfirmedAt ? `已确认 ${fmtTime(h.outgoingConfirmedAt)}` : '待确认') : '无需确认（柜台无人）'}
              　接班方：{h.incomingConfirmedAt ? `已确认 ${fmtTime(h.incomingConfirmedAt)}` : '待确认'}
            </div>
            <div className="row-actions">
              {canAct && h.fromVolunteerId && !h.outgoingConfirmedAt && (
                <button className="mini" onClick={() => onConfirm(h.id, 'outgoing')}>
                  交班方确认
                </button>
              )}
              {canAct && !h.incomingConfirmedAt && (
                <button className="mini" onClick={() => onConfirm(h.id, 'incoming')}>
                  接班方确认
                </button>
              )}
              {role === 'coordinator' && (
                <button className="ghost mini" onClick={() => onCancel(h.id)}>
                  取消交接
                </button>
              )}
            </div>
          </div>
        );
      })}
      {recent.length > 0 && <div className="panel-sub">最近交接</div>}
      {recent.map((h) => (
        <div key={h.id} className="muted">
          {COUNTER_FULL_NAME[h.counter]} {nameOf(h.fromVolunteerId)} → {nameOf(h.toVolunteerId)} ·{' '}
          {h.status === 'effective' ? `已生效 ${h.effectiveAt ? fmtTime(h.effectiveAt) : ''}` : '已取消'}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 预约
// ---------------------------------------------------------------------------

const BOOKING_LABEL: Record<Booking['status'], string> = {
  booked: '可办理',
  waiting: '等待',
  rescheduled: '已改约',
  served: '已办理',
  cancelled: '已取消',
};

function BookingTone(s: Booking['status']): string {
  if (s === 'booked') return 'green';
  if (s === 'waiting') return 'red';
  if (s === 'rescheduled') return 'orange';
  if (s === 'served') return 'blue';
  return 'gray';
}

export function BookingsPanel({
  state,
  role,
  onCreate,
  onReschedule,
  onCancel,
  onServe,
}: {
  state: ShelterState;
  role: Role;
  onCreate: (counter: CounterId, start: number, end: number, residentRef: string) => void;
  onReschedule: (bookingId: string, start: number, end: number) => void;
  onCancel: (bookingId: string) => void;
  onServe: (bookingId: string) => void;
}) {
  const canManage = role === 'receptionist' || role === 'coordinator';
  const canServe = role === 'receptionist' || role === 'duty' || role === 'volunteer';
  const [counter, setCounter] = useState<CounterId>('A');
  const [start, setStart] = useState('14:10');
  const [end, setEnd] = useState('14:30');
  const [ref, setRef] = useState('');
  const [reschedFor, setReschedFor] = useState('');
  const [rs, setRs] = useState('15:30');
  const [re, setRe] = useState('15:50');
  const sorted = [...state.bookings].sort((a, b) => a.slotStart - b.slotStart);

  return (
    <div className="card">
      <div className="panel-title">预约（只有实际在岗才放号）</div>
      {canManage && (
        <div className="inline-form">
          放号
          <select value={counter} onChange={(e) => setCounter(e.target.value as CounterId)}>
            <option value="A">接待柜台A</option>
            <option value="B">物资柜台B</option>
          </select>
          <input type="time" value={start} onChange={(e) => setStart(e.target.value)} />
          <span>–</span>
          <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
          <input placeholder="居民编号/称谓" value={ref} onChange={(e) => setRef(e.target.value)} />
          <button
            className="mini"
            disabled={!ref.trim()}
            onClick={() => {
              const r = rangeFromInputs(state, start, end);
              onCreate(counter, r.start, r.end, ref);
              setRef('');
            }}
          >
            放号
          </button>
        </div>
      )}
      {sorted.map((b) => (
        <div key={b.id} className="booking-row">
          <div>
            <Badge text={BOOKING_LABEL[b.status]} tone={BookingTone(b.status)} />{' '}
            <b>{COUNTER_FULL_NAME[b.counter]}</b> {fmtSlot(b)} · {b.residentRef}
            {b.status === 'waiting' && <Badge text="等待·不可办理" tone="red" />}
            {b.wasRescheduled && <Badge text="曾改约" tone="orange" />}
          </div>
          {b.rescheduleNote && <div className="muted">{b.rescheduleNote}</div>}
          {b.waitingReason && <div className="muted">{b.waitingReason.replace('[自动] ', '')}</div>}
          {b.servedBy && <div className="muted">办理人：{volunteerById(state, b.servedBy)?.name ?? b.servedBy}</div>}
          {(b.status === 'booked' || b.status === 'waiting') && (
            <div className="row-actions">
              {canServe && b.status === 'booked' && (
                <button className="mini" onClick={() => onServe(b.id)}>
                  办理
                </button>
              )}
              {canManage && (
                <>
                  <button className="ghost mini" onClick={() => setReschedFor(reschedFor === b.id ? '' : b.id)}>
                    改约
                  </button>
                  <button className="ghost mini" onClick={() => onCancel(b.id)}>
                    取消
                  </button>
                </>
              )}
            </div>
          )}
          {canManage && reschedFor === b.id && (
            <div className="inline-form">
              改约至
              <input type="time" value={rs} onChange={(e) => setRs(e.target.value)} />
              <span>–</span>
              <input type="time" value={re} onChange={(e) => setRe(e.target.value)} />
              <button
                className="mini"
                onClick={() => {
                  const r = rangeFromInputs(state, rs, re);
                  onReschedule(b.id, r.start, r.end);
                  setReschedFor('');
                }}
              >
                确认改约
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 志愿者视角：本人状态
// ---------------------------------------------------------------------------

export function MyShiftPanel({ state, volunteer, onSignIn, onSignOut }: {
  state: ShelterState;
  volunteer: Volunteer;
  onSignIn: (counter: CounterId) => void;
  onSignOut: (attendanceId: string) => void;
}) {
  const open = openAttendanceOf(state, volunteer.id);
  const upcoming = state.shifts
    .filter((s) => s.status === 'planned' && s.volunteerId === volunteer.id && s.end > state.virtualNow)
    .sort((a, b) => a.start - b.start);
  return (
    <div className="card">
      <div className="panel-title">我的班次（{volunteer.name}）</div>
      <div className="muted">技能：{volunteer.skills.map((c) => COUNTER_FULL_NAME[c]).join('、')}</div>
      {open ? (
        <div className="c-ok">
          当前在岗：{COUNTER_FULL_NAME[open.counter]}（自 {fmtTime(open.signedInAt)}）
          <button className="ghost mini" onClick={() => onSignOut(open.id)}>
            离岗
          </button>
        </div>
      ) : (
        <div className="muted">当前不在岗</div>
      )}
      <div className="panel-sub">待上岗班次</div>
      {upcoming.length === 0 && <div className="muted">（无）</div>}
      {upcoming.map((s) => (
        <div key={s.id} className="shift-row">
          <span>
            {fmtRange(s)} · {COUNTER_FULL_NAME[s.counter]}
          </span>
          {!open && s.start <= state.virtualNow + 30 * 60_000 && (
            <button className="mini" onClick={() => onSignIn(s.counter)}>
              签到
            </button>
          )}
        </div>
      ))}
      <div className="muted">交接确认：请在上方「交接」面板确认与本人相关的交接。</div>
    </div>
  );
}

