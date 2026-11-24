import { ensureDb, getPool, hasDatabase, isProductionRuntime } from "@/lib/db";
import { promises as fs } from "fs";
import path from "path";

export type OutboxStatus = "pending" | "processing" | "completed" | "failed" | "dead";
export type VerificationProcessingOutbox = {
  id: string;
  jobId: string;
  recordId: string;
  ownerUserId: string;
  projectId: string | null;
  claimGeneration: number;
  operation: "process_verification_result";
  status: OutboxStatus;
  attemptCount: number;
  maxAttempts: number;
  lastError?: string | null;
  leaseOwner?: string | null;
  leaseExpiresAt?: string | null;
  availableAt: string;
  createdAt: string;
  updatedAt: string;
  processedAt?: string | null;
};

const DATA_DIR = path.join(process.cwd(), "data", "verification");
const FILE = path.join(DATA_DIR, "processing-outbox.json");
const LEASE_MS = 5 * 60 * 1000;
function nowIso(){ return new Date().toISOString(); }
function canUseLocalFs(){ return !hasDatabase() && !isProductionRuntime(); }
async function ensureDir(){ await fs.mkdir(DATA_DIR,{recursive:true}); }
async function readFile(): Promise<VerificationProcessingOutbox[]> {
  if (!canUseLocalFs()) return [];
  await ensureDir();
  try { const raw=await fs.readFile(FILE,'utf8'); const p=JSON.parse(raw); return Array.isArray(p)?p:[]; } catch { return []; }
}
async function writeFile(rows: VerificationProcessingOutbox[]){ if(!canUseLocalFs()) throw new Error('Durable outbox storage not configured'); await ensureDir(); await fs.writeFile(FILE, JSON.stringify(rows.slice(0,1000),null,2),'utf8'); }

function rowToItem(r: Record<string, unknown>): VerificationProcessingOutbox {
  return {
    id:String(r.id), jobId:String(r.job_id), recordId:String(r.record_id), ownerUserId:String(r.owner_user_id), projectId:r.project_id==null?null:String(r.project_id),
    claimGeneration:Number(r.claim_generation||0), operation:"process_verification_result", status:String(r.status) as OutboxStatus,
    attemptCount:Number(r.attempt_count||0), maxAttempts:Number(r.max_attempts||8), lastError:r.last_error==null?null:String(r.last_error),
    leaseOwner:r.lease_owner==null?null:String(r.lease_owner), leaseExpiresAt:r.lease_expires_at?new Date(String(r.lease_expires_at)).toISOString():null,
    availableAt:new Date(String(r.available_at||r.created_at||nowIso())).toISOString(), createdAt:new Date(String(r.created_at||nowIso())).toISOString(),
    updatedAt:new Date(String(r.updated_at||nowIso())).toISOString(), processedAt:r.processed_at?new Date(String(r.processed_at)).toISOString():null,
  };
}

export async function enqueueVerificationProcessing(input: { jobId:string; recordId:string; ownerUserId:string; projectId:string|null; claimGeneration:number }): Promise<VerificationProcessingOutbox> {
  if (hasDatabase()) {
    await ensureDb();
    const p=getPool();
    const id = `${input.jobId}:${input.claimGeneration}:process_verification_result`;
    const res = await p.query(
      `INSERT INTO verification_processing_outbox (id, job_id, record_id, owner_user_id, project_id, claim_generation, operation, status, attempt_count, max_attempts, available_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'process_verification_result','pending',0,8,NOW(),NOW(),NOW())
       ON CONFLICT (job_id, claim_generation, operation) DO UPDATE SET updated_at=NOW()
       RETURNING *`,
      [id, input.jobId, input.recordId, input.ownerUserId, input.projectId, input.claimGeneration]
    );
    return rowToItem(res.rows[0] as Record<string,unknown>);
  }
  const rows = await readFile();
  const id = `${input.jobId}:${input.claimGeneration}:process_verification_result`;
  const existing = rows.find(r=>r.jobId===input.jobId && r.claimGeneration===input.claimGeneration && r.operation==='process_verification_result');
  if (existing) return existing;
  const item: VerificationProcessingOutbox = { id, jobId:input.jobId, recordId:input.recordId, ownerUserId:input.ownerUserId, projectId:input.projectId, claimGeneration:input.claimGeneration, operation:'process_verification_result', status:'pending', attemptCount:0, maxAttempts:8, availableAt:nowIso(), createdAt:nowIso(), updatedAt:nowIso(), lastError:null, leaseOwner:null, leaseExpiresAt:null, processedAt:null };
  rows.unshift(item); await writeFile(rows); return item;
}

async function claimOutboxRowWhere(whereSql: string, params: unknown[], workerId: string, leaseUntil: string): Promise<VerificationProcessingOutbox|null> {
  if (hasDatabase()) {
    await ensureDb();
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const res = await client.query(
        `UPDATE verification_processing_outbox
         SET status='processing', lease_owner=$1, lease_expires_at=$2::timestamptz, updated_at=NOW()
         WHERE id = (
           SELECT id FROM verification_processing_outbox
           WHERE ${whereSql}
           ORDER BY created_at ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         RETURNING *`,
        [workerId, leaseUntil, ...params]
      );
      await client.query('COMMIT');
      if (!res.rows[0]) return null;
      return rowToItem(res.rows[0] as Record<string,unknown>);
    } catch(e){ try{await client.query('ROLLBACK')}catch{} throw e; } finally { client.release(); }
  }
  return null;
}

export async function claimNextVerificationProcessing(opts?:{ workerId?:string; leaseMs?:number; jobId?:string; claimGeneration?:number }): Promise<VerificationProcessingOutbox|null> {
  const workerId = opts?.workerId || `worker-${process.pid}`;
  const leaseMs = opts?.leaseMs ?? LEASE_MS;
  const leaseUntil = new Date(Date.now()+leaseMs).toISOString();
  const base = `((status='pending' AND available_at <= NOW()) OR (status='failed' AND available_at <= NOW()) OR (status='processing' AND lease_expires_at IS NOT NULL AND lease_expires_at < NOW()))`;
  if (hasDatabase()) {
    const conds = [base];
    const extra: unknown[] = [];
    if (opts?.jobId) { extra.push(opts.jobId); conds.push(`job_id = $${extra.length + 2}`); }
    if (opts?.claimGeneration !== undefined) { extra.push(opts.claimGeneration); conds.push(`claim_generation = $${extra.length + 2}`); }
    return claimOutboxRowWhere(conds.join(' AND '), extra, workerId, leaseUntil);
  }
  const rows = await readFile();
  const idx = rows.findIndex(r => ((r.status==='pending' && new Date(r.availableAt).getTime()<=Date.now()) || (r.status==='failed' && new Date(r.availableAt).getTime()<=Date.now()) || (r.status==='processing' && r.leaseExpiresAt && new Date(r.leaseExpiresAt).getTime()<Date.now()))
    && (!opts?.jobId || r.jobId===opts.jobId) && (opts?.claimGeneration===undefined || r.claimGeneration===opts.claimGeneration));
  if (idx<0) return null;
  rows[idx] = { ...rows[idx], status:'processing', leaseOwner:workerId, leaseExpiresAt:leaseUntil, updatedAt:nowIso() };
  await writeFile(rows); return rows[idx];
}

export async function markVerificationProcessingCompleted(id:string, opts:{ workerId:string; claimGeneration:number }): Promise<boolean> {
  if (hasDatabase()) {
    await ensureDb();
    const res = await getPool().query(
      `UPDATE verification_processing_outbox SET status='completed', processed_at=NOW(), updated_at=NOW(), lease_owner=NULL, lease_expires_at=NULL, last_error=NULL
       WHERE id=$1 AND lease_owner=$2 AND claim_generation=$3 AND status='processing' RETURNING id`,
      [id, opts.workerId, opts.claimGeneration]
    );
    return (res.rowCount ?? 0) > 0;
  }
  const rows = await readFile(); const idx=rows.findIndex(r=>r.id===id && r.leaseOwner===opts.workerId && r.claimGeneration===opts.claimGeneration && r.status==='processing');
  if (idx<0) return false; rows[idx]={...rows[idx],status:'completed',processedAt:nowIso(),updatedAt:nowIso(),leaseOwner:null,leaseExpiresAt:null,lastError:null}; await writeFile(rows); return true;
}

export async function markVerificationProcessingFailed(id:string, opts:{ workerId:string; claimGeneration:number; error:string; retryDelayMs?:number }): Promise<boolean> {
  const retryDelayMs = opts.retryDelayMs ?? 30000;
  if (hasDatabase()) {
    await ensureDb();
    const res = await getPool().query(
      `UPDATE verification_processing_outbox
       SET attempt_count=attempt_count+1,
           status=CASE WHEN attempt_count+1 >= max_attempts THEN 'dead' ELSE 'failed' END,
           available_at=CASE WHEN attempt_count+1 >= max_attempts THEN NOW() ELSE NOW() + ($4::text || ' milliseconds')::interval END,
           last_error=$5, updated_at=NOW(), lease_owner=NULL, lease_expires_at=NULL
       WHERE id=$1 AND lease_owner=$2 AND claim_generation=$3 AND status='processing' RETURNING id`,
      [id, opts.workerId, opts.claimGeneration, String(retryDelayMs), opts.error.slice(0,1000)]
    );
    return (res.rowCount ?? 0) > 0;
  }
  const rows=await readFile(); const idx=rows.findIndex(r=>r.id===id && r.leaseOwner===opts.workerId && r.claimGeneration===opts.claimGeneration && r.status==='processing');
  if (idx<0) return false; const attempt=rows[idx].attemptCount+1; const dead=attempt>=rows[idx].maxAttempts;
  rows[idx]={...rows[idx],attemptCount:attempt,status:dead?'dead':'failed',availableAt:dead?nowIso():new Date(Date.now()+retryDelayMs).toISOString(),lastError:opts.error.slice(0,1000),updatedAt:nowIso(),leaseOwner:null,leaseExpiresAt:null};
  await writeFile(rows); return true;
}

export async function readOutboxItems(): Promise<VerificationProcessingOutbox[]> {
  if (hasDatabase()) { await ensureDb(); const res=await getPool().query('SELECT * FROM verification_processing_outbox ORDER BY created_at DESC LIMIT 200'); return res.rows.map(r=>rowToItem(r as Record<string,unknown>)); }
  return readFile();
}

/** @internal test-only */
export async function __unsafeWriteOutboxForTests(rows: VerificationProcessingOutbox[]): Promise<void> {
  if (hasDatabase()) { await ensureDb(); const p=getPool(); await p.query('DELETE FROM verification_processing_outbox'); for (const r of rows) { await p.query(`INSERT INTO verification_processing_outbox (id,job_id,record_id,owner_user_id,project_id,claim_generation,operation,status,attempt_count,max_attempts,last_error,lease_owner,lease_expires_at,available_at,created_at,updated_at,processed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::timestamptz,$14::timestamptz,$15::timestamptz,$16::timestamptz,$17::timestamptz)`, [r.id,r.jobId,r.recordId,r.ownerUserId,r.projectId,r.claimGeneration,r.operation,r.status,r.attemptCount,r.maxAttempts,r.lastError??null,r.leaseOwner??null,r.leaseExpiresAt??null,r.availableAt,r.createdAt,r.updatedAt,r.processedAt??null]); } return; }
  await writeFile(rows);
}
