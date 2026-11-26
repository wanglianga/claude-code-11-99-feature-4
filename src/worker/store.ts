import { openDB, type IDBPDatabase } from 'idb';
import { seedState } from '../engine/seed';
import type { ShelterState } from '../engine/types';

/**
 * IndexedDB 持久化：整份状态为单条记录，所有变更在单个 readwrite 事务内
 * 完成「读取 → 引擎校验 → 写回」。同一站点（origin）下多个标签页共享该库，
 * IndexedDB 会序列化同一 object store 上的 readwrite 事务，因此跨标签的
 * 并发命令（分房 / 返所 / 延期）天然按事务串行执行、彼此重新核对。
 */
const DB_NAME = 'shelter-workbench';
const STORE = 'kv';
const KEY = 'state';

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, 1, {
      upgrade(db) {
        db.createObjectStore(STORE);
      },
    });
  }
  return dbPromise;
}

export async function transact<T>(
  fn: (state: ShelterState) => { state?: ShelterState; out: T },
): Promise<T> {
  const db = await getDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  const raw = (await store.get(KEY)) as ShelterState | undefined;
  const result = fn(normalize(raw ?? seedState()));
  if (result.state) await store.put(result.state, KEY);
  await tx.done;
  return result.out;
}

export async function readState(): Promise<ShelterState> {
  const db = await getDb();
  const raw = (await db.get(STORE, KEY)) as ShelterState | undefined;
  return normalize(raw ?? seedState());
}

/**
 * 旧版本本地数据缺少柜台排班字段时补齐默认值（不丢家庭/床位数据）。
 * 若完全没有柜台/志愿者数据，则从种子中取柜台与志愿者定义，其余保持原状。
 */
function normalize(s: ShelterState): ShelterState {
  const seed = seedState();
  const patched: ShelterState = {
    ...s,
    counters: s.counters ?? seed.counters,
    volunteers: s.volunteers ?? seed.volunteers,
    blocks: s.blocks ?? [],
    skillRevocations: s.skillRevocations ?? [],
    plans: s.plans ?? [],
    shifts: s.shifts ?? [],
    attendances: s.attendances ?? [],
    handovers: s.handovers ?? [],
    bookings: s.bookings ?? [],
  };
  return patched;
}
