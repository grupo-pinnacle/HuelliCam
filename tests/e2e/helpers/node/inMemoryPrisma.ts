import { AsyncLocalStorage } from 'async_hooks';
import crypto from 'crypto';
import { Prisma } from '@prisma/client';

export type Row = Record<string, unknown>;

export interface CapturedSqlEntry {
  sql: string;
  params: unknown[];
}

export interface MethodCallEntry {
  model: string;
  method: string;
  args: unknown;
}

export interface InMemoryStore {
  user: Row[];
  pet: Row[];
  consultation: Row[];
  consultationAuditLog: Row[];
  message: Row[];
  call: Row[];
  prescription: Row[];
  review: Row[];
  auditLog: Row[];
  dailyUploadCounter: Row[];
  mediaFile: Row[];
  pushToken: Row[];
  notification: Row[];
  passwordResetToken: Row[];
  emailDispatchLog: Row[];
}

type StoreKey = keyof InMemoryStore;

function createEmptyStore(): InMemoryStore {
  return {
    user: [],
    pet: [],
    consultation: [],
    consultationAuditLog: [],
    message: [],
    call: [],
    prescription: [],
    review: [],
    auditLog: [],
    dailyUploadCounter: [],
    mediaFile: [],
    pushToken: [],
    notification: [],
    passwordResetToken: [],
    emailDispatchLog: [],
  };
}

function createP2002Error(target: string[]): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    `Unique constraint failed on the fields: (${target.join(',')})`,
    {
      code: 'P2002',
      clientVersion: '6.4.0',
      meta: { target },
    }
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

function normalizeComparable(val: unknown): unknown {
  if (val instanceof Date) return val.getTime();
  return val;
}

function matchesCondition(actual: unknown, expected: unknown): boolean {
  if (isPlainObject(expected)) {
    if ('in' in expected && Array.isArray(expected.in)) {
      return expected.in.some((item) => normalizeComparable(item) === normalizeComparable(actual));
    }
    if ('notIn' in expected && Array.isArray(expected.notIn)) {
      return !expected.notIn.some((item) => normalizeComparable(item) === normalizeComparable(actual));
    }
    if ('not' in expected) {
      return !matchesCondition(actual, expected.not);
    }
    if ('lt' in expected) {
      const a = normalizeComparable(actual);
      const b = normalizeComparable(expected.lt);
      return typeof a === 'number' && typeof b === 'number' ? a < b : String(a) < String(b);
    }
    if ('lte' in expected) {
      const a = normalizeComparable(actual);
      const b = normalizeComparable(expected.lte);
      return typeof a === 'number' && typeof b === 'number' ? a <= b : String(a) <= String(b);
    }
    if ('gt' in expected) {
      const a = normalizeComparable(actual);
      const b = normalizeComparable(expected.gt);
      return typeof a === 'number' && typeof b === 'number' ? a > b : String(a) > String(b);
    }
    if ('gte' in expected) {
      const a = normalizeComparable(actual);
      const b = normalizeComparable(expected.gte);
      return typeof a === 'number' && typeof b === 'number' ? a >= b : String(a) >= String(b);
    }
  }
  return normalizeComparable(actual) === normalizeComparable(expected);
}

export class InMemoryPrisma {
  public store: InMemoryStore = createEmptyStore();
  public capturedSql: CapturedSqlEntry[] = [];
  public methodCalls: MethodCallEntry[] = [];
  private autoIncrementId = 1;
  private txUndoAls = new AsyncLocalStorage<Array<() => void>>();

  public reset(): void {
    this.store = createEmptyStore();
    this.capturedSql = [];
    this.methodCalls = [];
    this.autoIncrementId = 1;
  }

  public getMethodCallCount(model: string, method?: string): number {
    return this.methodCalls.filter(
      (entry) => entry.model === model && (method ? entry.method === method : true)
    ).length;
  }

  private recordCall(model: string, method: string, args: unknown): void {
    this.methodCalls.push({ model, method, args });
  }

  private matchesWhere(model: StoreKey, row: Row, where?: Record<string, unknown>): boolean {
    if (!where) return true;

    for (const [key, value] of Object.entries(where)) {
      if (value === undefined) continue;

      if (key === 'OR' && Array.isArray(value)) {
        const anyMatch = value.some((sub) =>
          isPlainObject(sub) ? this.matchesWhere(model, row, sub) : false
        );
        if (!anyMatch) return false;
        continue;
      }

      if (key === 'AND' && Array.isArray(value)) {
        const allMatch = value.every((sub) =>
          isPlainObject(sub) ? this.matchesWhere(model, row, sub) : false
        );
        if (!allMatch) return false;
        continue;
      }

      if (key === 'userId_date' && model === 'dailyUploadCounter' && isPlainObject(value)) {
        if (row.userId !== value.userId || row.date !== value.date) return false;
        continue;
      }

      if (key === 'consultation' && isPlainObject(value) && typeof row.consultationId === 'string') {
        const parent = this.store.consultation.find((c) => c.id === row.consultationId);
        if (!parent || !this.matchesWhere('consultation', parent, value)) {
          return false;
        }
        continue;
      }

      if (!matchesCondition(row[key], value)) {
        return false;
      }
    }

    return true;
  }

  private applySelectAndInclude(
    model: StoreKey,
    row: Row,
    args?: { select?: Record<string, unknown>; include?: Record<string, unknown> }
  ): Row {
    const clone: Row = { ...row };

    if (args?.include) {
      if (model === 'consultation') {
        if (args.include.pet) {
          clone.pet = this.store.pet.find((p) => p.id === row.petId) ?? null;
        }
        if (args.include.client) {
          const client = this.store.user.find((u) => u.id === row.clientId) ?? null;
          clone.client =
            client && isPlainObject(args.include.client) && isPlainObject(args.include.client.select)
              ? this.pickSelect(client, args.include.client.select)
              : client;
        }
        if (args.include.vet) {
          const vet = row.vetId
            ? this.store.user.find((u) => u.id === row.vetId) ?? null
            : null;
          clone.vet =
            vet && isPlainObject(args.include.vet) && isPlainObject(args.include.vet.select)
              ? this.pickSelect(vet, args.include.vet.select)
              : vet;
        }
        if (args.include.prescriptions) {
          const list = this.store.prescription.filter((rx) => rx.consultationId === row.id);
          clone.prescriptions =
            isPlainObject(args.include.prescriptions) &&
            isPlainObject(args.include.prescriptions.select)
              ? list.map((rx) =>
                  this.pickSelect(rx, (args.include!.prescriptions as { select: Record<string, unknown> }).select)
                )
              : list;
        }
        if (args.include.review) {
          clone.review = this.store.review.find((r) => r.consultationId === row.id) ?? null;
        }
        if (args.include.calls) {
          clone.calls = this.store.call.filter((c) => c.consultationId === row.id);
        }
        if (args.include.auditLogs) {
          clone.auditLogs = this.store.consultationAuditLog.filter(
            (a) => a.consultationId === row.id
          );
        }
      }

      if (model === 'prescription') {
        if (args.include.vet) {
          const vet = this.store.user.find((u) => u.id === row.vetId) ?? null;
          clone.vet =
            vet && isPlainObject(args.include.vet) && isPlainObject(args.include.vet.select)
              ? this.pickSelect(vet, args.include.vet.select)
              : vet;
        }
        if (args.include.consultation) {
          const cons = this.store.consultation.find((c) => c.id === row.consultationId) ?? null;
          if (cons && isPlainObject(args.include.consultation) && isPlainObject(args.include.consultation.include)) {
            clone.consultation = this.applySelectAndInclude('consultation', cons, {
              include: args.include.consultation.include,
            });
          } else {
            clone.consultation = cons;
          }
        }
      }

      if (model === 'message' && args.include.sender) {
        const sender = this.store.user.find((u) => u.id === row.senderId) ?? null;
        clone.sender =
          sender && isPlainObject(args.include.sender) && isPlainObject(args.include.sender.select)
            ? this.pickSelect(sender, args.include.sender.select)
            : sender;
      }

      if (model === 'mediaFile' && args.include.consultation) {
        clone.consultation = row.consultationId
          ? this.store.consultation.find((c) => c.id === row.consultationId) ?? null
          : null;
      }
    }

    if (args?.select) {
      return this.pickSelect(clone, args.select);
    }

    return clone;
  }

  private pickSelect(row: Row, select: Record<string, unknown>): Row {
    const out: Row = {};
    for (const [k, v] of Object.entries(select)) {
      if (v) {
        out[k] = row[k];
      }
    }
    return out;
  }

  private applyDefaults(model: StoreKey, data: Row): Row {
    const now = new Date();
    const base: Row = {
      ...data,
      createdAt: data.createdAt ?? now,
      updatedAt: data.updatedAt ?? now,
    };

    if (model === 'consultationAuditLog') {
      base.id = data.id ?? BigInt(this.autoIncrementId++);
    } else {
      base.id = data.id ?? crypto.randomUUID();
    }

    if (model === 'user') {
      base.role = data.role ?? 'CLIENT';
      base.vetStatus = data.vetStatus ?? null;
      base.tokenVersion = data.tokenVersion ?? 1;
      base.ratingAvg = data.ratingAvg ?? 0;
      base.ratingCount = data.ratingCount ?? 0;
      base.isOnline = data.isOnline ?? false;
      base.lastSeen = data.lastSeen ?? null;
      base.deletedAt = data.deletedAt ?? null;
    } else if (model === 'pet') {
      base.deletedAt = data.deletedAt ?? null;
    } else if (model === 'consultation') {
      base.vetId = data.vetId ?? null;
      base.status = data.status ?? 'WAITING';
      base.transportStatus = data.transportStatus ?? 'OFFLINE';
      base.activeDeviceId = data.activeDeviceId ?? null;
      base.stateVersion = data.stateVersion ?? 1;
      base.claimedAt = data.claimedAt ?? null;
      base.startedAt = data.startedAt ?? null;
      base.endedAt = data.endedAt ?? null;
      base.deletedAt = data.deletedAt ?? null;
    } else if (model === 'call') {
      base.status = data.status ?? 'INITIATED';
      base.startedAt = data.startedAt ?? null;
      base.endedAt = data.endedAt ?? null;
      base.durationSeconds = data.durationSeconds ?? null;
      base.livekitRoomSid = data.livekitRoomSid ?? null;
      base.participantCount = data.participantCount ?? 0;
      base.errorCode = data.errorCode ?? null;
      base.errorMessage = data.errorMessage ?? null;
      base.disconnectReason = data.disconnectReason ?? null;
      base.lastEvent = data.lastEvent ?? null;
      base.metadata = data.metadata ?? null;
    } else if (model === 'dailyUploadCounter') {
      base.count = data.count ?? 0;
      base.totalBytes = data.totalBytes ?? BigInt(0);
    } else if (model === 'notification') {
      base.isRead = data.isRead ?? false;
      base.readAt = data.readAt ?? null;
    } else if (model === 'mediaFile') {
      base.deletedAt = data.deletedAt ?? null;
    } else if (model === 'message') {
      base.deletedAt = data.deletedAt ?? null;
    }

    return base;
  }

  private assertUniqueConstraints(model: StoreKey, candidate: Row, ignoreId?: unknown): void {
    const rows = this.store[model];
    if (model === 'user' && typeof candidate.email === 'string') {
      if (rows.some((r) => r.id !== ignoreId && r.email === candidate.email)) {
        throw createP2002Error(['email']);
      }
    }
    if (model === 'message' && typeof candidate.clientMsgId === 'string') {
      if (rows.some((r) => r.id !== ignoreId && r.clientMsgId === candidate.clientMsgId)) {
        throw createP2002Error(['client_msg_id']);
      }
    }
    if (model === 'pushToken' && typeof candidate.token === 'string') {
      if (rows.some((r) => r.id !== ignoreId && r.token === candidate.token)) {
        throw createP2002Error(['token']);
      }
    }
    if (model === 'review' && typeof candidate.consultationId === 'string') {
      if (rows.some((r) => r.id !== ignoreId && r.consultationId === candidate.consultationId)) {
        throw createP2002Error(['consultation_id']);
      }
    }
    if (model === 'dailyUploadCounter') {
      if (
        rows.some(
          (r) =>
            r.id !== ignoreId && r.userId === candidate.userId && r.date === candidate.date
        )
      ) {
        throw createP2002Error(['user_id', 'date']);
      }
    }
  }

  private applyPatch(row: Row, data: Row): Row {
    const updated: Row = { ...row, updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      if (isPlainObject(v) && ('increment' in v || 'decrement' in v)) {
        const current = row[k] ?? 0;
        if (typeof current === 'bigint' || typeof v.increment === 'bigint') {
          const delta = BigInt((v.increment as bigint | number | undefined) ?? 0) -
            BigInt((v.decrement as bigint | number | undefined) ?? 0);
          updated[k] = BigInt(current as bigint | number) + delta;
        } else {
          const delta = Number(v.increment ?? 0) - Number(v.decrement ?? 0);
          updated[k] = Number(current) + delta;
        }
      } else {
        updated[k] = v;
      }
    }
    return updated;
  }

  private sortRows(rows: Row[], orderBy?: Record<string, 'asc' | 'desc'>): Row[] {
    if (!orderBy) return rows;
    const entries = Object.entries(orderBy);
    if (entries.length === 0) return rows;
    const [field, direction] = entries[0];
    return [...rows].sort((a, b) => {
      const av = normalizeComparable(a[field]) ?? 0;
      const bv = normalizeComparable(b[field]) ?? 0;
      if (av === bv) return 0;
      const cmp = av < bv ? -1 : 1;
      return direction === 'desc' ? -cmp : cmp;
    });
  }

  private createDelegate(model: StoreKey) {
    return {
      findUnique: async (args: {
        where: Record<string, unknown>;
        select?: Record<string, unknown>;
        include?: Record<string, unknown>;
      }) => {
        this.recordCall(model, 'findUnique', args);
        const match = this.store[model].find((r) => this.matchesWhere(model, r, args.where));
        return match ? this.applySelectAndInclude(model, match, args) : null;
      },
      findFirst: async (args?: {
        where?: Record<string, unknown>;
        orderBy?: Record<string, 'asc' | 'desc'>;
        select?: Record<string, unknown>;
        include?: Record<string, unknown>;
      }) => {
        this.recordCall(model, 'findFirst', args);
        const matches = this.store[model].filter((r) =>
          this.matchesWhere(model, r, args?.where)
        );
        const sorted = this.sortRows(matches, args?.orderBy);
        return sorted[0] ? this.applySelectAndInclude(model, sorted[0], args) : null;
      },
      findMany: async (args?: {
        where?: Record<string, unknown>;
        orderBy?: Record<string, 'asc' | 'desc'>;
        take?: number;
        select?: Record<string, unknown>;
        include?: Record<string, unknown>;
      }) => {
        this.recordCall(model, 'findMany', args);
        const matches = this.store[model].filter((r) =>
          this.matchesWhere(model, r, args?.where)
        );
        const sorted = this.sortRows(matches, args?.orderBy);
        const sliced = typeof args?.take === 'number' ? sorted.slice(0, args.take) : sorted;
        return sliced.map((r) => this.applySelectAndInclude(model, r, args));
      },
      create: async (args: {
        data: Row;
        select?: Record<string, unknown>;
        include?: Record<string, unknown>;
      }) => {
        this.recordCall(model, 'create', args);
        const row = this.applyDefaults(model, args.data);
        this.assertUniqueConstraints(model, row);
        this.store[model].push(row);
        const undoOps = this.txUndoAls.getStore();
        if (undoOps) {
          const createdId = row.id;
          undoOps.push(() => {
            this.store[model] = this.store[model].filter((r) => r.id !== createdId);
          });
        }
        return this.applySelectAndInclude(model, row, args);
      },
      update: async (args: {
        where: Record<string, unknown>;
        data: Row;
        select?: Record<string, unknown>;
        include?: Record<string, unknown>;
      }) => {
        this.recordCall(model, 'update', args);
        const idx = this.store[model].findIndex((r) => this.matchesWhere(model, r, args.where));
        if (idx === -1) {
          throw new Prisma.PrismaClientKnownRequestError('Record to update not found', {
            code: 'P2025',
            clientVersion: '6.4.0',
          });
        }
        const prevRow = { ...this.store[model][idx] };
        const nextRow = this.applyPatch(prevRow, args.data);
        this.assertUniqueConstraints(model, nextRow, nextRow.id);
        this.store[model][idx] = nextRow;
        const undoOps = this.txUndoAls.getStore();
        if (undoOps) {
          const targetId = nextRow.id;
          undoOps.push(() => {
            const restoreIdx = this.store[model].findIndex((r) => r.id === targetId);
            if (restoreIdx !== -1) {
              this.store[model][restoreIdx] = prevRow;
            }
          });
        }
        return this.applySelectAndInclude(model, nextRow, args);
      },
      updateMany: async (args: { where?: Record<string, unknown>; data: Row }) => {
        this.recordCall(model, 'updateMany', args);
        let count = 0;
        const modified: Array<{ id: unknown; prevRow: Row }> = [];
        this.store[model] = this.store[model].map((row) => {
          if (this.matchesWhere(model, row, args.where)) {
            count++;
            const prevRow = { ...row };
            modified.push({ id: row.id, prevRow });
            return this.applyPatch(row, args.data);
          }
          return row;
        });
        const undoOps = this.txUndoAls.getStore();
        if (undoOps && modified.length > 0) {
          undoOps.push(() => {
            for (const entry of modified) {
              const restoreIdx = this.store[model].findIndex((r) => r.id === entry.id);
              if (restoreIdx !== -1) {
                this.store[model][restoreIdx] = entry.prevRow;
              }
            }
          });
        }
        return { count };
      },
      upsert: async (args: {
        where: Record<string, unknown>;
        create: Row;
        update: Row;
        select?: Record<string, unknown>;
        include?: Record<string, unknown>;
      }) => {
        this.recordCall(model, 'upsert', args);
        const idx = this.store[model].findIndex((r) => this.matchesWhere(model, r, args.where));
        const undoOps = this.txUndoAls.getStore();
        if (idx !== -1) {
          const prevRow = { ...this.store[model][idx] };
          const updated = this.applyPatch(prevRow, args.update);
          this.store[model][idx] = updated;
          if (undoOps) {
            const targetId = updated.id;
            undoOps.push(() => {
              const restoreIdx = this.store[model].findIndex((r) => r.id === targetId);
              if (restoreIdx !== -1) {
                this.store[model][restoreIdx] = prevRow;
              }
            });
          }
          return this.applySelectAndInclude(model, updated, args);
        }
        const created = this.applyDefaults(model, args.create);
        this.assertUniqueConstraints(model, created);
        this.store[model].push(created);
        if (undoOps) {
          const createdId = created.id;
          undoOps.push(() => {
            this.store[model] = this.store[model].filter((r) => r.id !== createdId);
          });
        }
        return this.applySelectAndInclude(model, created, args);
      },
      delete: async (args: { where: Record<string, unknown> }) => {
        this.recordCall(model, 'delete', args);
        const idx = this.store[model].findIndex((r) => this.matchesWhere(model, r, args.where));
        if (idx === -1) {
          throw new Prisma.PrismaClientKnownRequestError('Record to delete not found', {
            code: 'P2025',
            clientVersion: '6.4.0',
          });
        }
        const [removed] = this.store[model].splice(idx, 1);
        const undoOps = this.txUndoAls.getStore();
        if (undoOps) {
          const snapshotRow = { ...removed };
          undoOps.push(() => {
            if (!this.store[model].some((r) => r.id === snapshotRow.id)) {
              this.store[model].push(snapshotRow);
            }
          });
        }
        return removed;
      },
      deleteMany: async (args?: { where?: Record<string, unknown> }) => {
        this.recordCall(model, 'deleteMany', args);
        const kept: Row[] = [];
        const removed: Row[] = [];
        for (const row of this.store[model]) {
          if (this.matchesWhere(model, row, args?.where)) {
            removed.push({ ...row });
          } else {
            kept.push(row);
          }
        }
        this.store[model] = kept;
        const undoOps = this.txUndoAls.getStore();
        if (undoOps && removed.length > 0) {
          undoOps.push(() => {
            for (const row of removed) {
              if (!this.store[model].some((r) => r.id === row.id)) {
                this.store[model].push(row);
              }
            }
          });
        }
        return { count: removed.length };
      },
      count: async (args?: { where?: Record<string, unknown> }) => {
        this.recordCall(model, 'count', args);
        return this.store[model].filter((r) => this.matchesWhere(model, r, args?.where)).length;
      },
    };
  }

  public user = this.createDelegate('user');
  public pet = this.createDelegate('pet');
  public consultation = this.createDelegate('consultation');
  public consultationAuditLog = this.createDelegate('consultationAuditLog');
  public message = this.createDelegate('message');
  public call = this.createDelegate('call');
  public prescription = this.createDelegate('prescription');
  public review = this.createDelegate('review');
  public auditLog = this.createDelegate('auditLog');
  public dailyUploadCounter = this.createDelegate('dailyUploadCounter');
  public mediaFile = this.createDelegate('mediaFile');
  public pushToken = this.createDelegate('pushToken');
  public notification = this.createDelegate('notification');
  public passwordResetToken = this.createDelegate('passwordResetToken');
  public emailDispatchLog = this.createDelegate('emailDispatchLog');

  public $queryRaw = async (strings: TemplateStringsArray | string, ...values: unknown[]) => {
    const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
    return this.$queryRawUnsafe(sql, ...values);
  };

  public $queryRawUnsafe = async (sql: string, ...params: unknown[]) => {
    this.capturedSql.push({ sql, params });
    if (/information_schema\.columns/i.test(sql)) {
      return [{ 1: 1 }];
    }
    if (/SELECT\s+1/i.test(sql.trim())) {
      return [{ '?column?': 1 }];
    }
    if (/FROM\s+consultations/i.test(sql)) {
      const matches = this.store.consultation.filter((c) => {
        if (/WHERE\s+id\s*=\s*\$1/i.test(sql)) {
          return c.id === params[0];
        }
        if (/active_device_id\s*=\s*\$2/i.test(sql)) {
          return (
            c.clientId === params[0] &&
            c.activeDeviceId === params[1] &&
            [
              'TRIAGE_CRITICAL_QUEUED',
              'CLAIM_PENDING_SYNC',
              'LIVEKIT_CONNECTING',
              'IN_CALL_ACTIVE',
              'WAITING',
            ].includes(String(c.status))
          );
        }
        if (/WHERE\s+client_id\s*=\s*\$1/i.test(sql)) {
          return (
            c.clientId === params[0] &&
            [
              'TRIAGE_CRITICAL_QUEUED',
              'CLAIM_PENDING_SYNC',
              'LIVEKIT_CONNECTING',
              'IN_CALL_ACTIVE',
              'WAITING',
            ].includes(String(c.status))
          );
        }
        return false;
      });
      return matches.map((c) => ({
        id: c.id,
        client_id: c.clientId,
        vet_id: c.vetId ?? null,
        status: c.status,
        transport_status: c.transportStatus ?? 'OFFLINE',
        active_device_id: c.activeDeviceId ?? null,
        state_version: c.stateVersion ?? 1,
        claimed_at: c.claimedAt ?? null,
      }));
    }
    return [];
  };

  public $executeRaw = async (strings: TemplateStringsArray | string, ...values: unknown[]) => {
    const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
    return this.$executeRawUnsafe(sql, ...values);
  };

  public $executeRawUnsafe = async (sql: string, ...params: unknown[]) => {
    this.capturedSql.push({ sql, params });
    return 1;
  };

  public $transaction = async <T>(
    arg: ((tx: this) => Promise<T>) | Array<Promise<T>>
  ): Promise<T | T[]> => {
    if (Array.isArray(arg)) {
      return Promise.all(arg);
    }
    const undoOps: Array<() => void> = [];
    try {
      return await this.txUndoAls.run(undoOps, () => arg(this));
    } catch (err) {
      for (let i = undoOps.length - 1; i >= 0; i -= 1) {
        undoOps[i]();
      }
      throw err;
    }
  };

  public $connect = async (): Promise<void> => {};
  public $disconnect = async (): Promise<void> => {};
}

export function attachInMemoryPrisma(targetPrisma: object, mem: InMemoryPrisma): InMemoryPrisma {
  const target = targetPrisma as Record<string, unknown>;
  const keys: Array<keyof InMemoryPrisma> = [
    'user',
    'pet',
    'consultation',
    'consultationAuditLog',
    'message',
    'call',
    'prescription',
    'review',
    'auditLog',
    'dailyUploadCounter',
    'mediaFile',
    'pushToken',
    'notification',
    'passwordResetToken',
    'emailDispatchLog',
    '$queryRaw',
    '$queryRawUnsafe',
    '$executeRaw',
    '$executeRawUnsafe',
    '$transaction',
    '$connect',
    '$disconnect',
  ];
  for (const key of keys) {
    target[key as string] = mem[key];
  }
  return mem;
}
