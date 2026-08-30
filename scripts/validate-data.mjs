import { readFile } from 'node:fs/promises';

const dataUrl = new URL('../docs/data/board.json', import.meta.url);

let board;

try {
  board = JSON.parse(await readFile(dataUrl, 'utf8'));
} catch (error) {
  console.error(`FAIL: Could not parse docs/data/board.json: ${error.message}`);
  process.exit(1);
}

const errors = [];
const expectedChildren = new Map([
  ['xiaoyue', '黄小越'],
  ['xiaoyi', '黄小翊'],
]);
const validTaskStatuses = new Set(['not_started', 'in_progress', 'completed']);
const validRelatedTo = new Set(['xiaoyue', 'xiaoyi', 'family']);
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const isoDateTimePattern = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

function addError(path, message) {
  errors.push(`${path}: ${message}`);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireObject(parent, key, path) {
  const value = parent[key];

  if (!isObject(value)) {
    addError(path, 'must be an object');
    return {};
  }

  return value;
}

function requireArray(parent, key, path) {
  const value = parent[key];

  if (!Array.isArray(value)) {
    addError(path, 'must be an array');
    return [];
  }

  return value;
}

function validateString(value, path, { allowEmpty = true } = {}) {
  if (typeof value !== 'string') {
    addError(path, 'must be a string');
    return false;
  }

  if (!allowEmpty && value.trim() === '') {
    addError(path, 'must not be empty');
    return false;
  }

  return true;
}

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isRealDate(value) {
  const match = datePattern.exec(value);

  if (!match) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const daysByMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysByMonth[month - 1];
}

function timeToMinutes(value) {
  if (typeof value !== 'string' || !timePattern.test(value)) {
    return null;
  }

  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

const root = isObject(board) ? board : {};

if (!isObject(board)) {
  addError('root', 'must be an object');
}

const meta = requireObject(root, 'meta', 'meta');
validateString(meta.title, 'meta.title', { allowEmpty: false });

if (validateString(meta.timezone, 'meta.timezone', { allowEmpty: false })) {
  try {
    new Intl.DateTimeFormat('zh-CN', { timeZone: meta.timezone }).format();
  } catch {
    addError('meta.timezone', 'must be a valid IANA time zone');
  }
}

if (validateString(meta.lastUpdated, 'meta.lastUpdated', { allowEmpty: false })) {
  const match = isoDateTimePattern.exec(meta.lastUpdated);

  if (!match || !isRealDate(match[1]) || Number.isNaN(Date.parse(meta.lastUpdated))) {
    addError('meta.lastUpdated', 'must be a valid ISO 8601 date-time with an explicit time zone');
  }
}

const children = requireArray(root, 'children', 'children');
const seenChildIds = new Set();

if (children.length !== expectedChildren.size) {
  addError('children', 'must contain exactly xiaoyue and xiaoyi');
}

children.forEach((child, index) => {
  const path = `children[${index}]`;

  if (!isObject(child)) {
    addError(path, 'must be an object');
    return;
  }

  const idIsValidString = validateString(child.id, `${path}.id`, { allowEmpty: false });
  const nameIsValidString = validateString(child.name, `${path}.name`, { allowEmpty: false });

  if (idIsValidString) {
    if (seenChildIds.has(child.id)) {
      addError(`${path}.id`, `duplicate child ID "${child.id}"`);
    }
    seenChildIds.add(child.id);

    if (!expectedChildren.has(child.id)) {
      addError(`${path}.id`, 'must be xiaoyue or xiaoyi');
    } else if (nameIsValidString && child.name !== expectedChildren.get(child.id)) {
      addError(`${path}.name`, `must be "${expectedChildren.get(child.id)}" for ${child.id}`);
    }
  }
});

for (const childId of expectedChildren.keys()) {
  if (!seenChildIds.has(childId)) {
    addError('children', `missing required child "${childId}"`);
  }
}

const schedule = requireArray(root, 'schedule', 'schedule');
const tasks = requireArray(root, 'tasks', 'tasks');
const seenItemIds = new Map(
  [...seenChildIds].map((id) => [id, `children entry "${id}"`]),
);

function validateItemId(value, path, itemKind) {
  if (!validateString(value, path, { allowEmpty: false })) {
    return;
  }

  if (seenItemIds.has(value)) {
    addError(path, `duplicate ID "${value}"; first used by ${seenItemIds.get(value)}`);
    return;
  }

  seenItemIds.set(value, itemKind);
}

schedule.forEach((entry, index) => {
  const path = `schedule[${index}]`;

  if (!isObject(entry)) {
    addError(path, 'must be an object');
    return;
  }

  validateItemId(entry.id, `${path}.id`, path);

  if (validateString(entry.childId, `${path}.childId`, { allowEmpty: false }) && !expectedChildren.has(entry.childId)) {
    addError(`${path}.childId`, 'must be xiaoyue or xiaoyi');
  }

  if (!Number.isInteger(entry.weekday) || entry.weekday < 1 || entry.weekday > 7) {
    addError(`${path}.weekday`, 'must be an integer from 1 to 7');
  }

  const startMinutes = timeToMinutes(entry.startTime);
  const endMinutes = timeToMinutes(entry.endTime);

  if (startMinutes === null) {
    addError(`${path}.startTime`, 'must use valid 24-hour HH:MM format');
  }
  if (endMinutes === null) {
    addError(`${path}.endTime`, 'must use valid 24-hour HH:MM format');
  }
  if (startMinutes !== null && endMinutes !== null && endMinutes <= startMinutes) {
    addError(`${path}.endTime`, 'must be later than startTime');
  }

  validateString(entry.title, `${path}.title`, { allowEmpty: false });
  validateString(entry.location, `${path}.location`);
  validateString(entry.note, `${path}.note`);
});

tasks.forEach((task, index) => {
  const path = `tasks[${index}]`;

  if (!isObject(task)) {
    addError(path, 'must be an object');
    return;
  }

  validateItemId(task.id, `${path}.id`, path);
  validateString(task.title, `${path}.title`, { allowEmpty: false });

  if (validateString(task.relatedTo, `${path}.relatedTo`, { allowEmpty: false }) && !validRelatedTo.has(task.relatedTo)) {
    addError(`${path}.relatedTo`, 'must be xiaoyue, xiaoyi, or family');
  }

  if (!validateString(task.dueDate, `${path}.dueDate`, { allowEmpty: false }) || !isRealDate(task.dueDate)) {
    if (typeof task.dueDate === 'string' && task.dueDate.trim() !== '') {
      addError(`${path}.dueDate`, 'must be a real calendar date in YYYY-MM-DD format');
    }
  }

  if (validateString(task.status, `${path}.status`, { allowEmpty: false }) && !validTaskStatuses.has(task.status)) {
    addError(`${path}.status`, 'must be not_started, in_progress, or completed');
  }

  validateString(task.note, `${path}.note`);
});

if (errors.length > 0) {
  console.error(`FAIL: docs/data/board.json has ${errors.length} validation error${errors.length === 1 ? '' : 's'}:`);
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(`PASS: docs/data/board.json is valid (${children.length} children, ${schedule.length} schedule entries, ${tasks.length} tasks).`);
