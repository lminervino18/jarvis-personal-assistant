import type { ToolCoverage, ToolErrorCode, ToolFailure, ToolPage, ToolSource, ToolSuccess } from "@jarvis/contracts";

export function ok<T>(
  source: ToolSource,
  items: T[],
  extra: { page?: ToolPage; coverage?: ToolCoverage; note?: string } = {},
): ToolSuccess<T> {
  return { ok: true, source, fetchedAt: new Date().toISOString(), items, ...extra };
}

export function fail(code: ToolErrorCode, message: string, retryable = false, actionId?: string): ToolFailure {
  return { ok: false, error: { code, message, retryable, ...(actionId ? { actionId } : {}) } };
}
