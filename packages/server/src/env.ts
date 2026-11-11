import { z } from "zod";

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  /** Per-client budget for /store and /admin; a real store tunes this to its traffic. */
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(120),
});
export type Env = z.infer<typeof EnvSchema>;

/**
 * Validate process env at startup. Failure reports variable names and reasons only, never values,
 * since `DATABASE_URL` carries credentials.
 */
export const loadEnv = (source: Record<string, string | undefined>): Env => {
  const result = EnvSchema.safeParse(source);
  if (result.success) return result.data;
  const problems = result.error.issues.map(
    (i) => `${i.path.join(".")}: ${i.message}`,
  );
  throw new Error(`Invalid environment: ${problems.join("; ")}`);
};
