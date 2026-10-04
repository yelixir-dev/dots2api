import { Database } from "bun:sqlite";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { accountIdSchema, jobIdSchema, providerIdSchema } from "./contracts";
import type { Account, AccountId, Credentials, Job, JobId, JobImage, ProviderId, RunImage } from "./contracts";
import { IMAGE_EXTENSIONS, IMAGE_MIMES, MAX_IMAGE_BYTES, MAX_IMAGES, pngSize, sniffImage } from "./images";

const accountSchema = z.preprocess((raw) => {
  if (typeof raw !== "object" || raw === null || "enabled" in raw || !("chatEnabled" in raw)) return raw;
  return { ...raw, enabled: raw.chatEnabled === true || ("imageEnabled" in raw && raw.imageEnabled === true) };
}, z.object({
  id: accountIdSchema,
  provider: providerIdSchema,
  label: z.string(),
  enabled: z.boolean(),
  status: z.enum(["unconnected", "ready", "error"]),
  detail: z.string(),
  createdAt: z.string(),
  checkedAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  hasCredentials: z.boolean(),
  busy: z.boolean(),
}));
const jobSchema = z.object({
  id: jobIdSchema,
  accountId: accountIdSchema,
  provider: providerIdSchema,
  prompt: z.string(),
  status: z.enum(["running", "completed", "failed", "unknown"]),
  output: z.string(),
  error: z.string().nullable(),
  remoteId: z.string().nullable(),
  images: z.array(z.object({
    mime: z.enum(IMAGE_MIMES), bytes: z.number().int().nonnegative(),
    width: z.number().int().positive().optional(), height: z.number().int().positive().optional(),
    revisedPrompt: z.string().optional(),
  })).default([]),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
const credentialsSchema = z.record(z.string(), z.string());
type Row = { readonly body: string };

export class Store {
  readonly db: Database;
  readonly apiKey: string;
  private readonly key: Buffer;

  constructor(readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    chmodSync(dataDir, 0o700);
    const keyPath = join(dataDir, "master.key");
    if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: "wx" });
    this.key = readFileSync(keyPath);
    if (this.key.length !== 32) throw new Error("Invalid data/master.key; restore the original key.");
    chmodSync(keyPath, 0o600);
    const dbPath = join(dataDir, "dots2api.sqlite");
    // The project was renamed from bot2api; adopt its database (and the write-ahead files) once.
    const legacy = join(dataDir, "bot2api.sqlite");
    if (!existsSync(dbPath) && existsSync(legacy)) {
      for (const suffix of ["", "-wal", "-shm"]) if (existsSync(legacy + suffix)) renameSync(legacy + suffix, dbPath + suffix);
    }
    this.db = new Database(dbPath, { create: true });
    chmodSync(dbPath, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, body TEXT NOT NULL, credentials TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const existing = this.db.query<{ value: string }, []>("SELECT value FROM settings WHERE name='api_key'").get();
    this.apiKey = existing?.value ?? `d2a_${randomBytes(32).toString("base64url")}`;
    if (!existing) this.db.query("INSERT INTO settings VALUES ('api_key', ?)").run(this.apiKey);
    this.dropRetiredProviders();
  }

  /** Muse and Grok Bot support was removed; their accounts, jobs, images and browser profiles are deleted once. */
  private dropRetiredProviders(): void {
    const retired = this.db.query<{ id: string }, []>("SELECT id FROM jobs WHERE json_extract(body, '$.provider') NOT IN ('dots')").all();
    for (const job of retired) rmSync(join(this.dataDir, "images", job.id), { recursive: true, force: true });
    this.db.exec(`
      DELETE FROM jobs WHERE json_extract(body, '$.provider') NOT IN ('dots');
      DELETE FROM accounts WHERE json_extract(body, '$.provider') NOT IN ('dots');
    `);
    rmSync(join(this.dataDir, "muse"), { recursive: true, force: true });
  }

  /** Called by the serving process at startup, never by read-only diagnostics. */
  recoverInterruptedJobs(): void {
    const interrupted = this.db.query<Row, []>("SELECT body FROM jobs WHERE json_extract(body, '$.status') = 'running'")
      .all().map((row) => jobSchema.parse(JSON.parse(row.body)));
    for (const job of interrupted) {
      if (job.status === "running") {
        this.saveJob({
          ...job,
          status: "unknown",
          error: "Gateway restarted. Remote work may still be running; check the provider before retrying.",
          finishedAt: new Date().toISOString(),
        });
        const account = this.account(job.accountId);
        if (account) this.saveAccount({
          ...account, status: "error",
          detail: "Interrupted work may still be active remotely. Inspect it before checking this account again.",
        });
      }
    }
  }

  private seal(credentials: Credentials): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(credentials), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
  }

  credentials(id: AccountId): Credentials {
    const row = this.db.query<{ credentials: string }, [string]>("SELECT credentials FROM accounts WHERE id=?").get(id);
    if (!row) throw new Error("Account disappeared while reading credentials.");
    const sealed = Buffer.from(row.credentials, "base64");
    const decipher = createDecipheriv("aes-256-gcm", this.key, sealed.subarray(0, 12));
    decipher.setAuthTag(sealed.subarray(12, 28));
    const clear = Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]);
    return credentialsSchema.parse(JSON.parse(clear.toString("utf8")));
  }

  accounts(): Account[] {
    return this.db.query<Row, []>("SELECT body FROM accounts ORDER BY rowid DESC").all()
      .map((row) => accountSchema.parse(JSON.parse(row.body)));
  }
  account(id: AccountId): Account | null {
    const row = this.db.query<Row, [string]>("SELECT body FROM accounts WHERE id=?").get(id);
    return row ? accountSchema.parse(JSON.parse(row.body)) : null;
  }
  createAccount(provider: ProviderId, label: string, credentials: Credentials): Account {
    const account: Account = {
      id: accountIdSchema.parse(crypto.randomUUID()), provider, label, enabled: true,
      status: "unconnected", detail: "Connection has not been checked.",
      createdAt: new Date().toISOString(), checkedAt: null, lastUsedAt: null,
      hasCredentials: Object.keys(credentials).length > 0, busy: false,
    };
    this.db.query("INSERT INTO accounts VALUES (?, ?, ?)").run(account.id, JSON.stringify(account), this.seal(credentials));
    return account;
  }
  saveAccount(account: Account, credentials?: Credentials): Account {
    const updated = { ...account, busy: false };
    if (credentials) {
      updated.hasCredentials = Object.keys(credentials).length > 0;
      this.db.query("UPDATE accounts SET body=?, credentials=? WHERE id=?")
        .run(JSON.stringify(updated), this.seal(credentials), account.id);
    } else {
      this.db.query("UPDATE accounts SET body=? WHERE id=?").run(JSON.stringify(updated), account.id);
    }
    return updated;
  }
  deleteAccount(id: AccountId): void {
    this.db.query("DELETE FROM accounts WHERE id=?").run(id);
  }
  jobs(): Job[] {
    return this.db.query<Row, []>("SELECT body FROM jobs ORDER BY rowid DESC LIMIT 200").all()
      .map((row) => jobSchema.parse(JSON.parse(row.body)));
  }
  job(id: JobId): Job | null {
    const row = this.db.query<Row, [string]>("SELECT body FROM jobs WHERE id=?").get(id);
    return row ? jobSchema.parse(JSON.parse(row.body)) : null;
  }
  saveJob(job: Job): Job {
    this.db.query("INSERT INTO jobs VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET body=excluded.body")
      .run(job.id, job.accountId, JSON.stringify(job));
    return job;
  }
  /** Images live beside the database (`data/images/<job id>/<index>`), never inside it. */
  private imagePath(jobId: JobId, index: number): string {
    return join(this.dataDir, "images", jobId, String(index));
  }
  saveImages(jobId: JobId, images: readonly RunImage[]): JobImage[] {
    const saved: JobImage[] = [];
    const directory = join(this.dataDir, "images", jobId);
    for (const image of images.slice(0, MAX_IMAGES)) {
      const mime = sniffImage(image.data);
      if (!mime || image.data.byteLength > MAX_IMAGE_BYTES) continue;
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(this.imagePath(jobId, saved.length), image.data, { mode: 0o600 });
      const size = pngSize(image.data);
      saved.push({
        mime, bytes: image.data.byteLength, ...(size ?? {}),
        ...(image.revisedPrompt ? { revisedPrompt: image.revisedPrompt.slice(0, 4000) } : {}),
      });
    }
    return saved;
  }
  image(jobId: JobId, index: number): { readonly mime: JobImage["mime"]; readonly extension: string; readonly data: Uint8Array<ArrayBuffer> } | null {
    const image = this.job(jobId)?.images[index];
    if (!image) return null;
    try {
      return { mime: image.mime, extension: IMAGE_EXTENSIONS[image.mime], data: new Uint8Array(readFileSync(this.imagePath(jobId, index))) };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  }
  close(): void { this.db.close(); }
}
