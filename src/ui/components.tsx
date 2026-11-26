import { useState } from 'react';
import {
  FAMILY_STATUS_LABEL,
  PROMISE_STATUS_LABEL,
  ROLE_LABEL,
  STRATEGY_LABEL,
  activePromiseOf,
  checkInvariants,
  eligibility,
  latestStaleDraftOf,
  openDraftOf,
  openTaskOf,
  pendingOf,
  roomBuckets,
  suggestRooms,
} from '../engine/engine';
import { fmtDateTime, fmtTime } from '../engine/format';
import type { Family, ProtectionStrategy, Receipt, Role, Room, ShelterState } from '../engine/types';

// ---------------------------------------------------------------------------
// 通用小部件
// ---------------------------------------------------------------------------

export function Badge({ text, tone = 'gray' }: { text: string; tone?: string }) {
  return <span className={`badge badge-${tone}`}>{text}</span>;
}

export function FamilyBadges({ f }: { f: Family }) {
  return (
    <span className="badges">
      {f.needsAccessible && <Badge text="需无障碍" tone="purple" />}
      <Badge text={f.coRoomConsent ? '同意共房' : '不同意共房'} tone={f.coRoomConsent ? 'green' : 'red'} />
      <Badge text={f.consentRoomChange ? '同意返所换房' : '不同意换房'} tone={f.consentRoomChange ? 'green' : 'gray'} />
    </span>
  );
}

export function BucketsBar({ state, room }: { state: ShelterState; room: Room }) {
  const b = roomBuckets(state, room.id);
  const seg = (n: number, cls: string, title: string) =>
    n > 0 ? <div className={`seg ${cls}`} style={{ flexGrow: n }} title={title} /> : null;
  return (
    <div>
      <div className="bucket-bar">
        {seg(b.present, 'seg-present', `在场 ${b.present}`)}
        {seg(b.confirming, 'seg-confirming', `确认中 ${b.confirming}`)}
        {seg(b.protected, 'seg-protected', `保护中 ${b.protected}`)}
        {seg(Math.max(0, b.capacity - b.present - b.confirming - b.protected), 'seg-free', `可分配 ${b.allocatable}`)}
      </div>
      <div className="bucket-nums">
        <span>容量 {b.capacity}</span>
        <span className="c-present">在场 {b.present}</span>
        <span className="c-confirming">确认中 {b.confirming}</span>
        <span className="c-protected">保护中 {b.protected}</span>
        <span className="c-free">可分配 {b.allocatable}</span>
        {b.drafts > 0 && <span className="c-draft">草稿 {b.drafts}（不占床）</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 房间看板
// ---------------------------------------------------------------------------

export function RoomCard({
  state,
  room,
  role,
  onCloseRoom,
  onReopenRoom,
}: {
  state: ShelterState;
  room: Room;
  role: Role;
  onCloseRoom: (roomId: string) => void;
  onReopenRoom: (roomId: string) => void;
}) {
  const occupants = state.families.filter((f) => f.status === 'checked_in' && f.currentRoomId === room.id);
  const confirming = state.assignments.filter((a) => a.roomId === room.id && a.status === 'confirming');
  const promises = state.promises.filter(
    (p) => p.roomId === room.id && (p.status === 'active' || p.status === 'expired_contact'),
  );
  const drafts = state.assignments.filter((a) => a.roomId === room.id && a.status === 'draft_open');
  const famOf = (id: string) => state.families.find((f) => f.id === id);
  const isManager = role === 'bed_manager';

  return (
    <div className={`card room-card ${room.status === 'closed' ? 'room-closed' : ''}`}>
      <div className="room-head">
        <span className="room-name">{room.name} 房</span>
        {room.accessible && <Badge text="无障碍" tone="purple" />}
        {room.status === 'closed' ? <Badge text={`已关闭：${room.closedReason ?? ''}`} tone="red" /> : <Badge text="开放中" tone="green" />}
      </div>
      <BucketsBar state={state} room={room} />
      <div className="room-section">
        <div className="room-section-title">在场家庭</div>
        {occupants.length === 0 && <div className="muted">（无）</div>}
        {occupants.map((f) => (
          <div key={f.id} className="room-line">
            {f.name} · {f.size}人
          </div>
        ))}
        {confirming.map((a) => (
          <div key={a.id} className="room-line c-confirming">
            {famOf(a.familyId)?.name} · {a.beds}人（入住确认中…）
          </div>
        ))}
      </div>
      <div className="room-section">
        <div className="room-section-title">返所保护</div>
        {promises.length === 0 && <div className="muted">（无）</div>}
        {promises.map((p) => {
          const f = famOf(p.familyId);
          return (
            <div key={p.id} className="room-line c-protected">
              {f?.name} · {p.beds}床 · {STRATEGY_LABEL[p.strategy]} · 至{fmtTime(p.expectedReturnAt)} ·{' '}
              {PROMISE_STATUS_LABEL[p.status]}
            </div>
          );
        })}
      </div>
      {drafts.length > 0 && (
        <div className="room-section">
          <div className="room-section-title">草稿（不占床位）</div>
          {drafts.map((a) => (
            <div key={a.id} className="room-line c-draft">
              {famOf(a.familyId)?.name} · {a.beds}人
            </div>
          ))}
        </div>
      )}
      <div className="room-actions">
        {room.status === 'open' ? (
          <button disabled={!isManager} title={isManager ? '' : '需床位管理员角色'} onClick={() => onCloseRoom(room.id)}>
            临时关闭
          </button>
        ) : (
          <button disabled={!isManager} title={isManager ? '' : '需床位管理员角色'} onClick={() => onReopenRoom(room.id)}>
            重新开放
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 家庭列表
// ---------------------------------------------------------------------------

export interface FamilyHandlers {
  onStartDraft: (familyId: string) => void;
  onCancelDraft: (assignmentId: string) => void;
  onSubmitCheckIn: (assignmentId: string) => void;
  onStartLeave: (familyId: string) => void;
  onReturn: (familyId: string) => void;
  onExtend: (familyId: string) => void;
  onCheckout: (familyId: string) => void;
  onRetryStale: (familyId: string, roomId: string) => void;
  onDuplicateLeave: (familyId: string) => void;
  canDuplicateLeave: (familyId: string) => boolean;
}

export function FamilyList({
  state,
  role,
  h,
}: {
  state: ShelterState;
  role: Role;
  h: FamilyHandlers;
}) {
  const isReceptionist = role === 'receptionist';
  const isDuty = role === 'duty';
  const active = state.families.filter((f) => f.status !== 'checked_out');
  const checkedOut = state.families.filter((f) => f.status === 'checked_out');

  const renderFamily = (f: Family) => {
    const draft = openDraftOf(state, f.id);
    const confirmingAssign = state.assignments.find((a) => a.familyId === f.id && a.status === 'confirming');
    const stale = latestStaleDraftOf(state, f.id);
    const promise = activePromiseOf(state, f.id);
    const pendingCheckin = pendingOf(state, f.id, 'checkin');
    const pendingCheckout = pendingOf(state, f.id, 'checkout');
    const roomOf = (id?: string) => state.rooms.find((r) => r.id === id);

    let location = '';
    if (f.status === 'checked_in') location = `位置：${roomOf(f.currentRoomId)?.name ?? '?'}房`;
    else if (f.status === 'confirming') location = `位置：入住确认中 → ${roomOf(confirmingAssign?.roomId)?.name ?? ''}房`;
    else if (f.status === 'temp_leave' && promise)
      location = `位置：暂离在外（承诺：${roomOf(promise.roomId)?.name}房${promise.beds}床 · ${STRATEGY_LABEL[promise.strategy]} · 至${fmtTime(promise.expectedReturnAt)} · ${PROMISE_STATUS_LABEL[promise.status]}）`;
    else if (f.status === 'draft' && draft) location = `位置：草稿 → ${roomOf(draft.roomId)?.name}房（不占床位）`;
    else location = '位置：待安置（无床位）';

    return (
      <div key={f.id} className="card family-row">
        <div className="family-head">
          <span className="family-name">
            {f.name} · {f.size}人
          </span>
          <FamilyBadges f={f} />
          <Badge text={FAMILY_STATUS_LABEL[f.status]} tone={f.status === 'temp_leave' ? 'blue' : f.status === 'checked_in' ? 'green' : 'gray'} />
        </div>
        <div className="muted">{location}</div>
        {pendingCheckin && <div className="c-confirming">⏳ 现场入住核实中（本地模拟适配器）…</div>}
        {pendingCheckout && <div className="c-confirming">⏳ 退住核实中（楼层值班员）…</div>}
        {f.status === 'temp_leave' && promise && (
          <div className="muted">
            返所承诺：{STRATEGY_LABEL[promise.strategy]}，保护 {promise.roomId === promise.originRoomId ? '原房原床' : `${roomOf(promise.roomId)?.name}房`} {promise.beds} 床
          </div>
        )}
        {stale && (f.status === 'registered' || f.status === 'draft') && (
          <div className="stale-box">
            ⚠ 失效草稿：→ {roomOf(stale.roomId)?.name}房｜{stale.conflictReason}
            <button
              className="mini"
              disabled={!isReceptionist}
              title={isReceptionist ? '按失效草稿的原输入重新创建' : '需接待员角色'}
              onClick={() => h.onRetryStale(f.id, stale.roomId)}
            >
              按原输入重试
            </button>
          </div>
        )}
        <div className="row-actions">
          {f.status === 'registered' && (
            <button disabled={!isReceptionist} title={isReceptionist ? '' : '需接待员角色'} onClick={() => h.onStartDraft(f.id)}>
              草稿分房
            </button>
          )}
          {f.status === 'draft' && draft && (
            <>
              <button disabled={!isReceptionist} title={isReceptionist ? '' : '需接待员角色'} onClick={() => h.onSubmitCheckIn(draft.id)}>
                提交入住确认
              </button>
              <button disabled={!isReceptionist} title={isReceptionist ? '' : '需接待员角色'} onClick={() => h.onCancelDraft(draft.id)}>
                取消草稿
              </button>
            </>
          )}
          {f.status === 'checked_in' && !pendingCheckout && (
            <>
              <button disabled={!isReceptionist} title={isReceptionist ? '' : '需接待员角色'} onClick={() => h.onStartLeave(f.id)}>
                暂离登记
              </button>
              <button disabled={!isDuty} title={isDuty ? '' : '需楼层值班员角色'} onClick={() => h.onCheckout(f.id)}>
                核实退住
              </button>
            </>
          )}
          {f.status === 'temp_leave' && !pendingCheckout && (
            <>
              <button disabled={!isReceptionist} title={isReceptionist ? '' : '需接待员角色'} onClick={() => h.onReturn(f.id)}>
                确认返所
              </button>
              <button disabled={!isDuty} title={isDuty ? '' : '需楼层值班员角色'} onClick={() => h.onExtend(f.id)}>
                延期1小时
              </button>
              <button disabled={!isDuty} title={isDuty ? '' : '需楼层值班员角色'} onClick={() => h.onCheckout(f.id)}>
                核实退住
              </button>
              {h.canDuplicateLeave(f.id) && (
                <button className="ghost" title="以相同 commandId 重发上一条暂离命令，验证幂等" onClick={() => h.onDuplicateLeave(f.id)}>
                  模拟重复提交暂离回执
                </button>
              )}
            </>
          )}
        </div>
      </div>
    );
  };

  return (
    <div>
      {active.map(renderFamily)}
      {checkedOut.length > 0 && (
        <div className="muted checked-out">
          已退住：{checkedOut.map((f) => f.name).join('、')}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 草稿分房面板
// ---------------------------------------------------------------------------

export function DraftPanel({
  state,
  family,
  onSubmit,
  onCancel,
}: {
  state: ShelterState;
  family: Family;
  onSubmit: (roomId: string) => void;
  onCancel: () => void;
}) {
  const options = suggestRooms(state, family);
  const firstOk = options.find((o) => o.issues.length === 0);
  const [roomId, setRoomId] = useState<string>(firstOk?.room.id ?? state.rooms[0]?.id ?? '');
  const selected = options.find((o) => o.room.id === roomId);
  return (
    <div className="card panel">
      <div className="panel-title">草稿分房：{family.name}（{family.size}人{family.needsAccessible ? '，需无障碍' : ''}）</div>
      {options.map(({ room, issues }) => {
        const b = roomBuckets(state, room.id);
        return (
          <label key={room.id} className={`option ${issues.length ? 'option-disabled' : ''}`}>
            <input type="radio" name={`draft-room-${family.id}`} checked={roomId === room.id} disabled={issues.length > 0} onChange={() => setRoomId(room.id)} />
            <span>
              {room.name}房（{room.accessible ? '无障碍' : '普通'}，可分配 {b.allocatable} 床）
              {issues.length > 0 && <span className="option-issues">　✗ {issues.join('；')}</span>}
            </span>
          </label>
        );
      })}
      <div className="row-actions">
        <button disabled={!selected || selected.issues.length > 0} onClick={() => onSubmit(roomId)}>
          生成草稿（不占床位）
        </button>
        <button className="ghost" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 暂离登记面板
// ---------------------------------------------------------------------------

export function LeavePanel({
  state,
  family,
  onSubmit,
  onCancel,
}: {
  state: ShelterState;
  family: Family;
  onSubmit: (strategy: ProtectionStrategy, protectionRoomId: string | undefined, hours: number) => void;
  onCancel: () => void;
}) {
  const [strategy, setStrategy] = useState<ProtectionStrategy>('keep_room');
  const [hours, setHours] = useState(3);
  const originRoom = state.rooms.find((r) => r.id === family.currentRoomId);
  const protectionOptions = state.rooms
    .filter((r) => r.id !== family.currentRoomId)
    .map((r) => ({ room: r, issues: eligibility(state, family, r) }));
  const firstOk = protectionOptions.find((o) => o.issues.length === 0);
  const [protectionRoomId, setProtectionRoomId] = useState<string>(firstOk?.room.id ?? '');
  const expected = state.virtualNow + hours * 3600_000;
  const selectedProtection = protectionOptions.find((o) => o.room.id === protectionRoomId);
  const canSubmit =
    strategy === 'keep_room' ||
    (family.consentRoomChange && !!selectedProtection && selectedProtection.issues.length === 0);

  return (
    <div className="card panel">
      <div className="panel-title">
        暂离登记：{family.name}（{family.size}人，当前在{originRoom?.name ?? '?'}房）
      </div>
      <div className="panel-sub">床位保护策略（两条路径都必须兑现返所权）：</div>
      <label className="option">
        <input type="radio" checked={strategy === 'keep_room'} onChange={() => setStrategy('keep_room')} />
        <span>
          原房原床保留 —— 回程明确；{originRoom?.name}房 {family.size} 床转为「保护中」，期间不参与分配（可能空置紧缺房间）
        </span>
      </label>
      <label className={`option ${!family.consentRoomChange ? 'option-disabled' : ''}`}>
        <input type="radio" checked={strategy === 'capacity'} disabled={!family.consentRoomChange} onChange={() => setStrategy('capacity')} />
        <span>
          容量保护（返所换房）—— 释放原房，另选房间保护 {family.size} 床作为返所安排
          {!family.consentRoomChange && <span className="option-issues">　✗ 家庭未事先同意返所换房</span>}
        </span>
      </label>
      {strategy === 'capacity' && (
        <div className="panel-indent">
          {protectionOptions.length === 0 && <div className="muted">（无其他房间可选）</div>}
          {protectionOptions.map(({ room, issues }) => {
            const b = roomBuckets(state, room.id);
            return (
              <label key={room.id} className={`option ${issues.length ? 'option-disabled' : ''}`}>
                <input type="radio" checked={protectionRoomId === room.id} disabled={issues.length > 0} onChange={() => setProtectionRoomId(room.id)} />
                <span>
                  保护于 {room.name}房（{room.accessible ? '无障碍' : '普通'}，可分配 {b.allocatable} 床）
                  {issues.length > 0 && <span className="option-issues">　✗ {issues.join('；')}</span>}
                </span>
              </label>
            );
          })}
        </div>
      )}
      <div className="panel-sub">
        预计返所：
        <select value={hours} onChange={(e) => setHours(Number(e.target.value))}>
          {[1, 2, 3, 4, 5].map((n) => (
            <option key={n} value={n}>
              {n} 小时后（{fmtTime(state.virtualNow + n * 3600_000)}）
            </option>
          ))}
        </select>
        　即 {fmtDateTime(expected)}
      </div>
      <div className="row-actions">
        <button disabled={!canSubmit} onClick={() => onSubmit(strategy, strategy === 'capacity' ? protectionRoomId : undefined, hours)}>
          登记暂离并开具回执
        </button>
        <button className="ghost" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 待安置列表（含原因）
// ---------------------------------------------------------------------------

export function PendingPlacementPanel({ state }: { state: ShelterState }) {
  const waiting = state.families.filter((f) => f.status === 'registered' && !openDraftOf(state, f.id));
  return (
    <div className="card">
      <div className="panel-title">待安置（{waiting.length}）</div>
      {waiting.length === 0 && <div className="muted">（无等待安置的家庭）</div>}
      {waiting.map((f) => (
        <div key={f.id} className="waiting-item">
          <div>
            {f.name} · {f.size}人 {f.needsAccessible && '· 需无障碍'}
          </div>
          <ul className="reason-list">
            {suggestRooms(state, f).map(({ room, issues }) =>
              issues.length > 0 ? (
                <li key={room.id}>
                  {room.name}房：{issues.join('；')}
                </li>
              ) : (
                <li key={room.id} className="c-present">
                  {room.name}房：可分配，请创建草稿
                </li>
              ),
            )}
          </ul>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 联系核实任务
// ---------------------------------------------------------------------------

export function TasksPanel({
  state,
  role,
  onExtend,
  onCheckout,
  onNote,
}: {
  state: ShelterState;
  role: Role;
  onExtend: (familyId: string) => void;
  onCheckout: (familyId: string) => void;
  onNote: (taskId: string, note: string) => void;
}) {
  const open = state.contactTasks.filter((t) => t.status === 'open');
  const isDuty = role === 'duty';
  return (
    <div className="card">
      <div className="panel-title">联系核实任务（{open.length}）</div>
      {open.length === 0 && <div className="muted">（无任务：承诺到期未归时自动生成，不自动退住）</div>}
      {open.map((t) => {
        const fam = state.families.find((f) => f.id === t.familyId);
        const promise = state.promises.find((p) => p.id === t.promiseId);
        if (!fam) return null;
        return (
          <div key={t.id} className="task-item">
            <div>
              <b>{fam.name}</b>（{fam.size}人）约定 {promise ? fmtTime(promise.expectedReturnAt) : '?'} 返所，到期未归
            </div>
            <div className="muted">床位继续保护中，返所权有效；请电话联系核实，勿直接退住</div>
            {t.notes.map((n, i) => (
              <div key={i} className="muted">
                · {n}
              </div>
            ))}
            <div className="row-actions">
              <button disabled={!isDuty} title={isDuty ? '' : '需楼层值班员角色'} onClick={() => onExtend(fam.id)}>
                延期1小时
              </button>
              <button disabled={!isDuty} title={isDuty ? '' : '需楼层值班员角色'} onClick={() => onCheckout(fam.id)}>
                核实退住
              </button>
              <button
                disabled={!isDuty}
                title={isDuty ? '' : '需楼层值班员角色'}
                onClick={() => {
                  const note = window.prompt('联系情况备注', '已电话联系，事务未办完');
                  if (note) onNote(t.id, note);
                }}
              >
                添加备注
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 回执流
// ---------------------------------------------------------------------------

const RECEIPT_KIND_LABEL: Record<string, string> = {
  seed: '初始化',
  reset: '重置',
  family_registered: '登记',
  draft_created: '草稿',
  draft_cancelled: '草稿',
  draft_stale: '草稿失效',
  checkin_submitted: '入住确认',
  checkin_confirmed: '入住确认',
  checkin_failed: '入住确认',
  leave_registered: '暂离',
  duplicate_submission: '重复回执',
  return_confirmed: '返所',
  promise_extended: '延期',
  promise_expired: '承诺逾期',
  checkout_submitted: '退住核实',
  checkout_confirmed: '退住核实',
  room_closed: '房间',
  room_reopened: '房间',
  clock_advanced: '时钟',
  task_note: '联系任务',
  volunteer_registered: '志愿者',
  volunteer_block_added: '休息/任务',
  skill_revoked: '技能撤销',
  skill_restored: '技能恢复',
  roster_generated: '班表',
  shift_assigned: '排班',
  shift_cancelled: '排班',
  counter_window_opened: '柜台',
  sign_in: '签到',
  sign_out: '离岗',
  handover_requested: '交接',
  handover_confirmed_side: '交接',
  handover_effective: '交接',
  handover_cancelled: '交接',
  booking_created: '预约',
  booking_rescheduled: '预约',
  booking_cancelled: '预约',
  booking_served: '预约',
  booking_affected: '预约受影响',
  booking_restored: '预约恢复',
};

export function ReceiptsPanel({ receipts }: { receipts: Receipt[] }) {
  const sorted = [...receipts].sort((a, b) => b.seq - a.seq).slice(0, 80);
  return (
    <div className="card receipts">
      <div className="panel-title">操作回执（{receipts.length}）</div>
      {sorted.map((r) => (
        <div key={r.id} className={`receipt ${r.pending ? 'receipt-pending' : ''} ${r.duplicateOf ? 'receipt-dup' : ''}`}>
          <div className="receipt-head">
            <span className="receipt-seq">#{r.seq}</span>
            <span className="muted">{fmtDateTime(r.at)}</span>
            <Badge text={RECEIPT_KIND_LABEL[r.kind] ?? r.kind} tone="gray" />
            <span className="muted">{r.actor}</span>
            {r.pending && <Badge text="异步待确认" tone="orange" />}
            {r.duplicateOf && <Badge text={`重复·原${r.duplicateOf}`} tone="blue" />}
          </div>
          <div>{r.summary}</div>
          {r.lines.map((l, i) => (
            <div key={i} className="muted receipt-line">
              {l}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 核对面板（不变量）
// ---------------------------------------------------------------------------

export function InvariantsPanel({ state }: { state: ShelterState }) {
  const results = checkInvariants(state);
  return (
    <div className="card">
      <div className="panel-title">全所核对（家庭唯一位置 / 实际人数 / 床位权利）</div>
      {results.map((r) => (
        <div key={r.name} className={`invariant ${r.ok ? 'inv-ok' : 'inv-bad'}`}>
          <span>{r.ok ? '✓' : '✗'}</span>
          <span>
            <b>{r.name}</b>　<span className="muted">{r.detail}</span>
          </span>
        </div>
      ))}
      <div className="muted">口径说明：实际在场 = 已完成现场入住确认的人数；保护中 = 有效返所承诺占用床位；可分配 = 容量 − 在场 − 确认中 − 保护中（草稿不占床）。</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 新家庭登记
// ---------------------------------------------------------------------------

export function NewFamilyForm({
  role,
  onSubmit,
}: {
  role: Role;
  onSubmit: (input: { name: string; size: number; needsAccessible: boolean; coRoomConsent: boolean; consentRoomChange: boolean }) => void;
}) {
  const [name, setName] = useState('');
  const [size, setSize] = useState(2);
  const [needsAccessible, setNeedsAccessible] = useState(false);
  const [coRoomConsent, setCoRoomConsent] = useState(true);
  const [consentRoomChange, setConsentRoomChange] = useState(false);
  const isReceptionist = role === 'receptionist';
  return (
    <div className="card">
      <div className="panel-title">新到家庭登记</div>
      <div className="form-grid">
        <label>
          名称
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：周洁一家" />
        </label>
        <label>
          人数
          <input type="number" min={1} max={20} value={size} onChange={(e) => setSize(Number(e.target.value))} />
        </label>
        <label>
          <input type="checkbox" checked={needsAccessible} onChange={(e) => setNeedsAccessible(e.target.checked)} /> 需要无障碍
        </label>
        <label>
          <input type="checkbox" checked={coRoomConsent} onChange={(e) => setCoRoomConsent(e.target.checked)} /> 同意共房
        </label>
        <label>
          <input type="checkbox" checked={consentRoomChange} onChange={(e) => setConsentRoomChange(e.target.checked)} /> 同意返所换房
        </label>
      </div>
      <div className="row-actions">
        <button
          disabled={!isReceptionist || !name.trim()}
          title={isReceptionist ? '' : '需接待员角色'}
          onClick={() => {
            onSubmit({ name, size, needsAccessible, coRoomConsent, consentRoomChange });
            setName('');
          }}
        >
          登记（进入待安置）
        </button>
      </div>
    </div>
  );
}

export { ROLE_LABEL };
