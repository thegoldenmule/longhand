/**
 * Environment configuration (documented in the repo's `.env.example`).
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repo root (paths like `.dev/witness-key.pem` are relative to it). */
export const REPO_ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));

/** Parsed configuration. */
export interface Config {
  port: number;
  host: string;
  /** Origin agent sessions post back to (default `http://127.0.0.1:{port}`). */
  internalUrl: string | null;
  databaseUrl: string;
  databaseSchema: string;
  durableStreamsUrl: string;
  streamPrefix: string;
  authMode: 'dev' | 'cognito';
  devAccountId: string;
  devUserId: string;
  cognito: { userPoolId: string; clientId: string; tokenUse: 'id' | 'access' };
  witnessSigner: 'file' | 'kms';
  witnessKeyPath: string;
  kmsKeyId: string;
  awsRegion: string | null;
  cadence: { everyCommits: number; intervalMs: number };
  modelAdapter: 'claude' | 'mock';
  claudeBin: string | null;
  models: { full: string; quick: string };
  mockStepDelayMs: number;
  corsOrigins: string[];
  preload: boolean;
  autoStartSessions: boolean;
}

function int(env: NodeJS.ProcessEnv, key: string, def: number): number {
  const v = env[key];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${key} must be a non-negative number`);
  return n;
}

function bool(env: NodeJS.ProcessEnv, key: string, def: boolean): boolean {
  const v = env[key];
  if (v === undefined || v === '') return def;
  return v === '1' || v.toLowerCase() === 'true';
}

/** Reads the configuration from the environment. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const authMode = (env.AUTH_MODE ?? 'dev') as Config['authMode'];
  if (authMode !== 'dev' && authMode !== 'cognito')
    throw new Error('AUTH_MODE must be dev or cognito');
  const witnessSigner = (env.WITNESS_SIGNER ?? 'file') as Config['witnessSigner'];
  if (witnessSigner !== 'file' && witnessSigner !== 'kms')
    throw new Error('WITNESS_SIGNER must be file or kms');
  const modelAdapter = (env.MODEL_ADAPTER ?? 'claude') as Config['modelAdapter'];
  if (modelAdapter !== 'claude' && modelAdapter !== 'mock')
    throw new Error('MODEL_ADAPTER must be claude or mock');
  const cfg: Config = {
    port: int(env, 'LEDGER_PORT', 3200),
    host: env.LEDGER_HOST ?? '127.0.0.1',
    internalUrl: env.LEDGER_INTERNAL_URL || null,
    databaseUrl: env.DATABASE_URL ?? 'postgres://longhand:longhand@localhost:5434/longhand',
    databaseSchema: env.DATABASE_SCHEMA ?? 'public',
    durableStreamsUrl: env.DURABLE_STREAMS_URL ?? 'http://127.0.0.1:3300',
    streamPrefix: env.DURABLE_STREAMS_PREFIX ?? 'longhand',
    authMode,
    devAccountId: env.DEV_ACCOUNT_ID ?? 'dev-account',
    devUserId: env.DEV_USER_ID ?? 'dev-writer',
    cognito: {
      userPoolId: env.COGNITO_USER_POOL_ID ?? '',
      clientId: env.COGNITO_CLIENT_ID ?? '',
      tokenUse: env.COGNITO_TOKEN_USE === 'id' ? 'id' : 'access',
    },
    witnessSigner,
    witnessKeyPath: resolve(REPO_ROOT, env.WITNESS_KEY_PATH ?? '.dev/witness-key.pem'),
    kmsKeyId: env.WITNESS_KMS_KEY_ID ?? '',
    awsRegion: env.AWS_REGION || env.COGNITO_REGION || null,
    cadence: {
      everyCommits: int(env, 'WITNESS_EMBED_EVERY_COMMITS', 256),
      intervalMs: int(env, 'WITNESS_EMBED_INTERVAL_MS', 10 * 60_000),
    },
    modelAdapter,
    claudeBin: env.CLAUDE_BIN || env.LONGHAND_CLAUDE_BIN || null,
    models: { full: env.AGENT_MODEL_FULL || 'opus', quick: env.AGENT_MODEL_QUICK || 'sonnet' },
    mockStepDelayMs: int(env, 'MOCK_STEP_DELAY_MS', 0),
    corsOrigins: (env.CORS_ORIGINS || `http://localhost:${env.WEB_PORT || 3100}`)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    preload: bool(env, 'PRELOAD_PROJECTS', false),
    autoStartSessions: bool(env, 'AGENT_AUTOSTART', true),
  };
  if (cfg.authMode === 'cognito' && (!cfg.cognito.userPoolId || !cfg.cognito.clientId)) {
    throw new Error('AUTH_MODE=cognito needs COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID');
  }
  if (cfg.witnessSigner === 'kms' && !cfg.kmsKeyId)
    throw new Error('WITNESS_SIGNER=kms needs WITNESS_KMS_KEY_ID');
  return cfg;
}
