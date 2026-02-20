import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

loadEnv();

const boolFromEnv = z
  .string()
  .optional()
  .transform((value) => {
    if (!value) {
      return false;
    }
    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
  });

const envSchema = z.object({
  NOTION_API_KEY: z.string().min(1, 'NOTION_API_KEY is required'),
  SSH_HOST: z.string().default('0.0.0.0'),
  SSH_PORT: z.coerce.number().int().positive().default(2222),
  SSH_HOST_KEY_PATH: z.string().default('.ssh/notion_ssh_host_key'),
  SSH_USERNAME: z.string().default('notion'),
  SSH_PASSWORD: z.string().default('notion'),
  SSH_ALLOW_ANY_PASSWORD: boolFromEnv.default(false),
  NOTION_ROOT_PAGE_ID: z
    .string()
    .optional()
    .transform((value) => (value && value.trim().length > 0 ? value : undefined)),
  CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info')
});

export type AppEnv = z.infer<typeof envSchema>;

export const env: AppEnv = envSchema.parse(process.env);
