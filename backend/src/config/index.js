'use strict';

/**
 * Configuration layer.
 *
 * Every environment variable the process depends on is declared, coerced and
 * validated here exactly once at boot. Modules never read `process.env`
 * directly — they import this frozen object. A missing or malformed value
 * fails fast at startup rather than surfacing as a 500 at 3am.
 */

require('dotenv').config();
const Joi = require('joi');

const csv = (value) =>
  String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

const schema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().port().default(4000),
  API_PREFIX: Joi.string().default('/api'),
  LOG_LEVEL: Joi.string().valid('error', 'warn', 'info', 'http', 'debug').default('info'),
  SHUTDOWN_TIMEOUT_MS: Joi.number().min(1000).default(15000),

  MONGO_URI: Joi.string().uri({ scheme: [/mongodb\+?s?r?v?/] }).required(),
  REDIS_HOST: Joi.string().default('127.0.0.1'),
  REDIS_PORT: Joi.number().port().default(6379),
  REDIS_PASSWORD: Joi.string().allow('').default(''),
  REDIS_DB: Joi.number().min(0).default(0),

  JWT_SECRET: Joi.string().min(32).required(),
  JWT_ACCESS_TTL: Joi.string().default('15m'),
  JWT_REFRESH_SECRET: Joi.string().min(32).required(),
  JWT_REFRESH_TTL: Joi.string().default('7d'),
  PASSWORD_SCRYPT_COST: Joi.number().valid(16384, 32768, 65536).default(16384),

  CORS_ORIGINS: Joi.string().default('http://localhost:4200'),
  RATE_LIMIT_WINDOW_MS: Joi.number().default(60000),
  RATE_LIMIT_MAX: Joi.number().default(300),
  PAYMENT_RATE_LIMIT_MAX: Joi.number().default(60),

  IDEMPOTENCY_TTL_SECONDS: Joi.number().default(86400),
  LOCK_TTL_MS: Joi.number().default(10000),
  LOCK_RETRY_COUNT: Joi.number().default(5),
  LOCK_RETRY_DELAY_MS: Joi.number().default(200),

  WEBHOOK_SIGNATURE_HEADER: Joi.string().default('x-payflux-signature'),
  WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS: Joi.number().default(300),
  WEBHOOK_MAX_ATTEMPTS: Joi.number().default(6),
  WEBHOOK_TIMEOUT_MS: Joi.number().default(8000),

  FRAUD_BLOCK_THRESHOLD: Joi.number().default(80),
  FRAUD_REVIEW_THRESHOLD: Joi.number().default(50),
  FRAUD_HIGH_AMOUNT_MINOR: Joi.number().default(50000000),
  FRAUD_VELOCITY_WINDOW_SECONDS: Joi.number().default(300),
  FRAUD_VELOCITY_MAX_ATTEMPTS: Joi.number().default(10),

  BREAKER_FAILURE_THRESHOLD: Joi.number().default(5),
  BREAKER_SUCCESS_THRESHOLD: Joi.number().default(2),
  BREAKER_TIMEOUT_MS: Joi.number().default(30000),

  SETTLEMENT_CRON: Joi.string().default('0 */6 * * *'),
  SETTLEMENT_HOLD_HOURS: Joi.number().default(24),
  PLATFORM_FEE_BPS: Joi.number().min(0).max(10000).default(200),
  ENABLE_SCHEDULERS: Joi.boolean().truthy('true').falsy('false').default(true),

  ACQUIRER_LATENCY_MS: Joi.number().default(120),
  ACQUIRER_FAILURE_RATE: Joi.number().min(0).max(1).default(0.08),
}).unknown(true);

const { value: env, error } = schema.validate(process.env, {
  abortEarly: false,
  stripUnknown: false,
});

if (error) {
  const details = error.details.map((d) => `  • ${d.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${details}`);
}

const config = Object.freeze({
  env: env.NODE_ENV,
  isProduction: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  port: env.PORT,
  apiPrefix: env.API_PREFIX,
  shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,

  log: { level: env.LOG_LEVEL },

  mongo: {
    uri: env.MONGO_URI,
    options: {
      maxPoolSize: 50,
      minPoolSize: 5,
      serverSelectionTimeoutMS: 8000,
      socketTimeoutMS: 45000,
      retryWrites: true,
    },
  },

  redis: {
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    password: env.REDIS_PASSWORD || undefined,
    db: env.REDIS_DB,
  },

  jwt: {
    accessSecret: env.JWT_SECRET,
    accessTtl: env.JWT_ACCESS_TTL,
    refreshSecret: env.JWT_REFRESH_SECRET,
    refreshTtl: env.JWT_REFRESH_TTL,
    issuer: 'payflux.io',
    audience: 'payflux-api',
  },

  security: {
    scryptCost: env.PASSWORD_SCRYPT_COST,
    corsOrigins: csv(env.CORS_ORIGINS),
    rateLimit: { windowMs: env.RATE_LIMIT_WINDOW_MS, max: env.RATE_LIMIT_MAX },
    paymentRateLimit: { windowMs: env.RATE_LIMIT_WINDOW_MS, max: env.PAYMENT_RATE_LIMIT_MAX },
  },

  idempotency: { ttlSeconds: env.IDEMPOTENCY_TTL_SECONDS },

  lock: {
    ttlMs: env.LOCK_TTL_MS,
    retryCount: env.LOCK_RETRY_COUNT,
    retryDelayMs: env.LOCK_RETRY_DELAY_MS,
    retryJitterMs: 100,
  },

  webhook: {
    signatureHeader: env.WEBHOOK_SIGNATURE_HEADER,
    timestampToleranceSeconds: env.WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
    maxAttempts: env.WEBHOOK_MAX_ATTEMPTS,
    timeoutMs: env.WEBHOOK_TIMEOUT_MS,
  },

  fraud: {
    blockThreshold: env.FRAUD_BLOCK_THRESHOLD,
    reviewThreshold: env.FRAUD_REVIEW_THRESHOLD,
    highAmountMinor: env.FRAUD_HIGH_AMOUNT_MINOR,
    velocityWindowSeconds: env.FRAUD_VELOCITY_WINDOW_SECONDS,
    velocityMaxAttempts: env.FRAUD_VELOCITY_MAX_ATTEMPTS,
  },

  breaker: {
    failureThreshold: env.BREAKER_FAILURE_THRESHOLD,
    successThreshold: env.BREAKER_SUCCESS_THRESHOLD,
    timeoutMs: env.BREAKER_TIMEOUT_MS,
  },

  settlement: {
    cron: env.SETTLEMENT_CRON,
    holdHours: env.SETTLEMENT_HOLD_HOURS,
    platformFeeBps: env.PLATFORM_FEE_BPS,
    enableSchedulers: env.ENABLE_SCHEDULERS,
  },

  acquirer: {
    latencyMs: env.ACQUIRER_LATENCY_MS,
    failureRate: env.ACQUIRER_FAILURE_RATE,
  },
});

module.exports = config;
