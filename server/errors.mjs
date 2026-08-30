export class AppError extends Error {
  constructor(message, {
    status = 500,
    code = 'internal_error',
    details,
    cause,
    expose = status < 500,
  } = {}) {
    super(message, { cause });
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = expose;
  }
}

export class RevisionConflictError extends AppError {
  constructor(currentRevision, publishedRevision = null) {
    super('The board changed on disk. Reload before saving or publishing.', {
      status: 409,
      code: 'revision_conflict',
      details: { currentRevision, publishedRevision },
    });
    this.name = 'RevisionConflictError';
  }
}

export class BoardValidationError extends AppError {
  constructor(errors) {
    super('Board validation failed.', {
      status: 422,
      code: 'validation_failed',
      details: { errors },
    });
    this.name = 'BoardValidationError';
  }
}
