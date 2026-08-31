const EXPECTED_CHILDREN = new Map([
  ['xiaoyue', '黄小越'],
  ['xiaoyi', '黄小翊'],
]);

const TASK_STATUSES = new Set(['not_started', 'in_progress', 'completed']);
const RELATED_TO = new Set(['xiaoyue', 'xiaoyi', 'family']);
const PHOTO_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const PHOTO_EXTENSIONS_BY_MIME = new Map([
  ['image/jpeg', new Set(['jpg', 'jpeg'])],
  ['image/png', new Set(['png'])],
  ['image/webp', new Set(['webp'])],
]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_WITH_ZONE_PATTERN = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const FULL_PHOTO_PATH_PATTERN = /^media\/full\/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:jpg|jpeg|png|webp)$/;
const THUMB_PHOTO_PATH_PATTERN = /^media\/thumb\/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:jpg|jpeg|png|webp)$/;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isRealDate(value) {
  if (typeof value !== 'string') {
    return false;
  }

  const match = DATE_PATTERN.exec(value);
  if (!match) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));

  return year >= 1
    && candidate.getUTCFullYear() === year
    && candidate.getUTCMonth() === month - 1
    && candidate.getUTCDate() === day;
}

function isIsoDateTimeWithZone(value) {
  return typeof value === 'string'
    && ISO_WITH_ZONE_PATTERN.test(value)
    && !Number.isNaN(Date.parse(value));
}

function timeToMinutes(value) {
  if (typeof value !== 'string' || !TIME_PATTERN.test(value)) {
    return null;
  }

  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

function pushError(errors, path, message, code = 'invalid') {
  errors.push({ path, message, code });
}

function validateString(errors, value, path, {
  allowEmpty = true,
  maxLength = 10_000,
} = {}) {
  if (typeof value !== 'string') {
    pushError(errors, path, 'must be a string', 'type');
    return false;
  }

  if (!allowEmpty && value.trim() === '') {
    pushError(errors, path, 'must not be empty', 'required');
    return false;
  }

  if (value.length > maxLength) {
    pushError(errors, path, `must be at most ${maxLength} characters`, 'too_long');
    return false;
  }

  return true;
}

function validateId(errors, value, path, seenIds, description) {
  if (!validateString(errors, value, path, { allowEmpty: false, maxLength: 128 })) {
    return;
  }

  if (!ID_PATTERN.test(value)) {
    pushError(errors, path, 'must use only letters, numbers, dot, underscore, colon, or hyphen', 'format');
  }

  if (seenIds.has(value)) {
    pushError(errors, path, `duplicate ID "${value}"; first used by ${seenIds.get(value)}`, 'duplicate');
  } else {
    seenIds.set(value, description);
  }
}

function photoExtension(value) {
  return typeof value === 'string' ? value.slice(value.lastIndexOf('.') + 1) : '';
}

function validatePhoto(errors, photo, path, seenPhotoIds) {
  if (!isPlainObject(photo)) {
    pushError(errors, path, 'must be an object', 'type');
    return;
  }

  validateId(errors, photo.id, `${path}.id`, seenPhotoIds, path);

  const validSrc = validateString(errors, photo.src, `${path}.src`, { allowEmpty: false, maxLength: 300 });
  if (validSrc && !FULL_PHOTO_PATH_PATTERN.test(photo.src)) {
    pushError(errors, `${path}.src`, 'must point to a safe JPEG, PNG, or WebP media/full filename', 'format');
  }

  if (validateString(errors, photo.thumbnail, `${path}.thumbnail`, { allowEmpty: false, maxLength: 300 })
      && !THUMB_PHOTO_PATH_PATTERN.test(photo.thumbnail)) {
    pushError(errors, `${path}.thumbnail`, 'must point to a safe JPEG, PNG, or WebP media/thumb filename', 'format');
  }

  validateString(errors, photo.caption, `${path}.caption`, { maxLength: 500 });

  if (!Number.isInteger(photo.width) || photo.width < 1 || photo.width > 2_000) {
    pushError(errors, `${path}.width`, 'must be an integer from 1 to 2000', 'range');
  }

  if (!Number.isInteger(photo.height) || photo.height < 1 || photo.height > 2_000) {
    pushError(errors, `${path}.height`, 'must be an integer from 1 to 2000', 'range');
  }

  const validMimeType = validateString(
    errors,
    photo.mimeType,
    `${path}.mimeType`,
    { allowEmpty: false, maxLength: 40 },
  );
  if (validMimeType && !PHOTO_MIME_TYPES.has(photo.mimeType)) {
    pushError(errors, `${path}.mimeType`, 'must be image/jpeg, image/png, or image/webp', 'enum');
  } else if (validMimeType && validSrc && FULL_PHOTO_PATH_PATTERN.test(photo.src)
      && !PHOTO_EXTENSIONS_BY_MIME.get(photo.mimeType)?.has(photoExtension(photo.src))) {
    pushError(errors, `${path}.src`, 'file extension must match mimeType', 'consistency');
  }
}

function validatePhotos(errors, value, path, seenPhotoIds) {
  if (!Array.isArray(value)) {
    pushError(errors, path, 'must be an array', 'type');
    return;
  }

  value.forEach((photo, index) => validatePhoto(errors, photo, `${path}[${index}]`, seenPhotoIds));
}

/**
 * Validate the complete family-board document without mutating it.
 *
 * @param {unknown} board
 * @returns {{ok: boolean, errors: Array<{path: string, message: string, code: string}>}}
 */
export function validateBoard(board) {
  const errors = [];

  if (!isPlainObject(board)) {
    pushError(errors, 'root', 'must be an object', 'type');
    return { ok: false, errors };
  }

  if (!Object.hasOwn(board, 'schemaVersion')) {
    pushError(errors, 'schemaVersion', 'is required and must be 1', 'required');
  } else if (board.schemaVersion !== 1) {
    pushError(errors, 'schemaVersion', 'must be 1', 'enum');
  }

  if (!isPlainObject(board.meta)) {
    pushError(errors, 'meta', 'must be an object', 'type');
  } else {
    validateString(errors, board.meta.title, 'meta.title', { allowEmpty: false, maxLength: 100 });

    if (validateString(errors, board.meta.timezone, 'meta.timezone', { allowEmpty: false, maxLength: 100 })) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: board.meta.timezone }).format();
      } catch {
        pushError(errors, 'meta.timezone', 'must be a valid IANA time zone', 'format');
      }
    }

    if (validateString(errors, board.meta.lastUpdated, 'meta.lastUpdated', { allowEmpty: false, maxLength: 80 })
        && !isIsoDateTimeWithZone(board.meta.lastUpdated)) {
      pushError(errors, 'meta.lastUpdated', 'must be an ISO 8601 date-time with an explicit time zone', 'format');
    }
  }

  const seenIds = new Map();
  const seenPhotoIds = new Map();

  if (!Array.isArray(board.children)) {
    pushError(errors, 'children', 'must be an array', 'type');
  } else {
    if (board.children.length !== EXPECTED_CHILDREN.size) {
      pushError(errors, 'children', 'must contain exactly xiaoyue and xiaoyi', 'cardinality');
    }

    const foundChildren = new Set();
    board.children.forEach((child, index) => {
      const path = `children[${index}]`;
      if (!isPlainObject(child)) {
        pushError(errors, path, 'must be an object', 'type');
        return;
      }

      validateId(errors, child.id, `${path}.id`, seenIds, path);
      validateString(errors, child.name, `${path}.name`, { allowEmpty: false, maxLength: 50 });

      if (typeof child.id === 'string') {
        foundChildren.add(child.id);
        if (!EXPECTED_CHILDREN.has(child.id)) {
          pushError(errors, `${path}.id`, 'must be xiaoyue or xiaoyi', 'enum');
        } else if (child.name !== EXPECTED_CHILDREN.get(child.id)) {
          pushError(errors, `${path}.name`, `must be "${EXPECTED_CHILDREN.get(child.id)}"`, 'value');
        }
      }
    });

    for (const childId of EXPECTED_CHILDREN.keys()) {
      if (!foundChildren.has(childId)) {
        pushError(errors, 'children', `is missing required child "${childId}"`, 'required');
      }
    }
  }

  if (!Array.isArray(board.schedule)) {
    pushError(errors, 'schedule', 'must be an array', 'type');
  } else {
    board.schedule.forEach((course, index) => {
      const path = `schedule[${index}]`;
      if (!isPlainObject(course)) {
        pushError(errors, path, 'must be an object', 'type');
        return;
      }

      validateId(errors, course.id, `${path}.id`, seenIds, path);

      if (validateString(errors, course.childId, `${path}.childId`, { allowEmpty: false, maxLength: 20 })
          && !EXPECTED_CHILDREN.has(course.childId)) {
        pushError(errors, `${path}.childId`, 'must be xiaoyue or xiaoyi', 'enum');
      }

      if (!Number.isInteger(course.weekday) || course.weekday < 1 || course.weekday > 7) {
        pushError(errors, `${path}.weekday`, 'must be an integer from 1 to 7', 'range');
      }

      validateString(errors, course.title, `${path}.title`, { allowEmpty: false, maxLength: 200 });
      validateString(errors, course.location, `${path}.location`, { maxLength: 500 });
      validateString(errors, course.note, `${path}.note`, { maxLength: 10_000 });

      const hasPeriodLabel = course.periodLabel !== undefined;
      const hasPeriodOrder = course.periodOrder !== undefined;
      if (hasPeriodLabel) {
        validateString(errors, course.periodLabel, `${path}.periodLabel`, { allowEmpty: false, maxLength: 100 });
      }
      if (hasPeriodOrder
          && (!Number.isInteger(course.periodOrder) || course.periodOrder < 1 || course.periodOrder > 1_000)) {
        pushError(errors, `${path}.periodOrder`, 'must be an integer from 1 to 1000', 'range');
      }
      if (hasPeriodLabel !== hasPeriodOrder) {
        pushError(errors, path, 'periodLabel and periodOrder must be provided together', 'consistency');
      }

      const hasStartTime = course.startTime !== undefined && course.startTime !== '';
      const hasEndTime = course.endTime !== undefined && course.endTime !== '';
      const startMinutes = timeToMinutes(course.startTime);
      const endMinutes = timeToMinutes(course.endTime);
      if (hasStartTime && startMinutes === null) {
        pushError(errors, `${path}.startTime`, 'must use valid 24-hour HH:MM format', 'format');
      }
      if (hasEndTime && endMinutes === null) {
        pushError(errors, `${path}.endTime`, 'must use valid 24-hour HH:MM format', 'format');
      }
      if (hasStartTime !== hasEndTime) {
        pushError(errors, path, 'startTime and endTime must be provided together', 'consistency');
      }
      if (hasStartTime && hasEndTime && startMinutes !== null && endMinutes !== null && endMinutes <= startMinutes) {
        pushError(errors, `${path}.endTime`, 'must be later than startTime', 'range');
      }
      if (!hasPeriodLabel && !hasStartTime && !hasEndTime) {
        pushError(errors, path, 'must include either a period label or an exact time range', 'required');
      }

      validatePhotos(errors, course.photos, `${path}.photos`, seenPhotoIds);
    });
  }

  if (!Array.isArray(board.tasks)) {
    pushError(errors, 'tasks', 'must be an array', 'type');
  } else {
    board.tasks.forEach((task, index) => {
      const path = `tasks[${index}]`;
      if (!isPlainObject(task)) {
        pushError(errors, path, 'must be an object', 'type');
        return;
      }

      validateId(errors, task.id, `${path}.id`, seenIds, path);
      validateString(errors, task.title, `${path}.title`, { allowEmpty: false, maxLength: 300 });

      if (validateString(errors, task.relatedTo, `${path}.relatedTo`, { allowEmpty: false, maxLength: 20 })
          && !RELATED_TO.has(task.relatedTo)) {
        pushError(errors, `${path}.relatedTo`, 'must be xiaoyue, xiaoyi, or family', 'enum');
      }

      if (validateString(errors, task.dueDate, `${path}.dueDate`, { allowEmpty: false, maxLength: 10 })
          && !isRealDate(task.dueDate)) {
        pushError(errors, `${path}.dueDate`, 'must be a real date in YYYY-MM-DD format', 'format');
      }

      if (validateString(errors, task.status, `${path}.status`, { allowEmpty: false, maxLength: 20 })
          && !TASK_STATUSES.has(task.status)) {
        pushError(errors, `${path}.status`, 'must be not_started, in_progress, or completed', 'enum');
      }

      if (task.status === 'completed') {
        if (!isIsoDateTimeWithZone(task.completedAt)) {
          pushError(errors, `${path}.completedAt`, 'is required for completed tasks and must include an explicit time zone', 'required');
        }
      } else if (task.completedAt !== undefined && task.completedAt !== null) {
        pushError(errors, `${path}.completedAt`, 'must be absent or null unless status is completed', 'consistency');
      }

      validateString(errors, task.note, `${path}.note`, { maxLength: 10_000 });
      validatePhotos(errors, task.photos, `${path}.photos`, seenPhotoIds);
    });
  }

  return { ok: errors.length === 0, errors };
}

export function formatValidationErrors(errors) {
  if (!Array.isArray(errors)) {
    return [];
  }

  return errors.map((error) => `${error.path}: ${error.message}`);
}

export const BOARD_SCHEMA_CONSTANTS = Object.freeze({
  childIds: Object.freeze([...EXPECTED_CHILDREN.keys()]),
  statuses: Object.freeze([...TASK_STATUSES]),
  relatedTo: Object.freeze([...RELATED_TO]),
  photoMimeTypes: Object.freeze([...PHOTO_MIME_TYPES]),
});
