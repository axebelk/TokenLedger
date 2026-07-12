/**
 * Error taxonomy. Services throw DomainError subclasses; each app has a single
 * onError mapper that turns them into RFC 9457 problem+json responses.
 */

export class DomainError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends DomainError {
  constructor(resource: string, id?: string) {
    super("not_found", 404, id ? `${resource} '${id}' not found` : `${resource} not found`);
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = "You do not have permission to perform this action") {
    super("forbidden", 403, message);
  }
}

export class UnauthorizedError extends DomainError {
  constructor(message = "Authentication required") {
    super("unauthorized", 401, message);
  }
}

export class ValidationError extends DomainError {
  constructor(message: string, details?: unknown) {
    super("validation_failed", 400, message, details);
  }
}

export class ConflictError extends DomainError {
  constructor(message: string) {
    super("conflict", 409, message);
  }
}

export class LicenseRequiredError extends DomainError {
  constructor(feature: string) {
    super("license_required", 402, `'${feature}' requires an enterprise license`);
  }
}

export class BudgetExceededError extends DomainError {
  constructor(
    readonly scope: string,
    readonly resetsAt: string,
    message: string,
  ) {
    super("budget_exceeded", 402, message);
  }
}

export class RateLimitedError extends DomainError {
  constructor(readonly retryAfterS: number) {
    super("rate_limited", 429, "Rate limit exceeded");
  }
}
