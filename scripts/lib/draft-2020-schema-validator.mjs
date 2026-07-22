const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';
const SUPPORTED_KEYWORDS = new Set([
  '$defs', '$id', '$ref', '$schema', 'additionalProperties', 'const', 'enum', 'format',
  'items', 'maximum', 'maxItems', 'minimum', 'minItems', 'minLength', 'oneOf', 'pattern',
  'properties', 'required', 'title', 'type', 'uniqueItems',
]);
const auditedSchemas = new WeakSet();

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function jsonEqual(left, right) {
  return stableJson(left) === stableJson(right);
}

function pointerValue(root, reference) {
  if (!reference.startsWith('#/')) throw new Error(`only local JSON Schema references are supported: ${reference}`);
  return reference.slice(2).split('/').reduce((value, token) => {
    const key = token.replaceAll('~1', '/').replaceAll('~0', '~');
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) {
      throw new Error(`unresolved JSON Schema reference: ${reference}`);
    }
    return value[key];
  }, root);
}

function assertSupportedSchema(schema, path = '$') {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error(`${path} must be an object JSON Schema`);
  }
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(key)) throw new Error(`${path} uses unsupported JSON Schema keyword ${key}`);
  }
  for (const [key, child] of Object.entries(schema.$defs || {})) assertSupportedSchema(child, `${path}.$defs.${key}`);
  for (const [key, child] of Object.entries(schema.properties || {})) assertSupportedSchema(child, `${path}.properties.${key}`);
  if (schema.items) assertSupportedSchema(schema.items, `${path}.items`);
  for (const [index, child] of (schema.oneOf || []).entries()) assertSupportedSchema(child, `${path}.oneOf[${index}]`);
}

function matchesType(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isSafeInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function validDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

function validDateTime(value) {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!match || !validDate(match[1])) return false;
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = Number(match[4]);
  return hour <= 23 && minute <= 59 && second <= 59 && Number.isFinite(Date.parse(value));
}

function validateNode(schema, value, path, root, errors) {
  if (schema.$ref) validateNode(pointerValue(root, schema.$ref), value, path, root, errors);

  if (Array.isArray(schema.oneOf)) {
    const candidates = schema.oneOf.map((candidate) => {
      const candidateErrors = [];
      validateNode(candidate, value, path, root, candidateErrors);
      return candidateErrors;
    });
    const matches = candidates.filter((candidateErrors) => candidateErrors.length === 0).length;
    if (matches !== 1) {
      errors.push(`${path} must match exactly one oneOf branch; matched ${matches}`);
      if (matches === 0) {
        const closest = [...candidates].sort((left, right) => left.length - right.length)[0] || [];
        errors.push(...closest);
      }
    }
    return;
  }

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(value, type))) {
      errors.push(`${path} must have type ${types.join('|')}`);
      return;
    }
  }
  if (Object.hasOwn(schema, 'const') && !jsonEqual(value, schema.const)) {
    errors.push(`${path} must equal the schema const`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => jsonEqual(candidate, value))) {
    errors.push(`${path} must equal one of the schema enum values`);
  }

  if (typeof value === 'string') {
    if (Number.isInteger(schema.minLength) && [...value].length < schema.minLength) {
      errors.push(`${path} is shorter than minLength ${schema.minLength}`);
    }
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) {
      errors.push(`${path} does not match pattern ${schema.pattern}`);
    }
    if (schema.format === 'date' && !validDate(value)) errors.push(`${path} is not a valid full-date`);
    if (schema.format === 'date-time' && !validDateTime(value)) errors.push(`${path} is not a valid date-time`);
  }

  if (typeof value === 'number') {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) errors.push(`${path} is below minimum ${schema.minimum}`);
    if (Number.isFinite(schema.maximum) && value > schema.maximum) errors.push(`${path} exceeds maximum ${schema.maximum}`);
  }

  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) errors.push(`${path} has fewer than ${schema.minItems} items`);
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) errors.push(`${path} has more than ${schema.maxItems} items`);
    if (schema.uniqueItems === true && new Set(value.map(stableJson)).size !== value.length) {
      errors.push(`${path} items must be unique`);
    }
    if (schema.items) value.forEach((item, index) => validateNode(schema.items, item, `${path}[${index}]`, root, errors));
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties || {};
    for (const key of schema.required || []) {
      if (!Object.hasOwn(value, key)) errors.push(`${path}.${key} is required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) errors.push(`${path}.${key} is not allowed`);
      }
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) validateNode(childSchema, value[key], `${path}.${key}`, root, errors);
    }
  }
}

export function validateDraft202012(schema, value, { label = 'document' } = {}) {
  if (!schema || schema.$schema !== DRAFT_2020_12) {
    throw new Error(`${label} JSON Schema must pin ${DRAFT_2020_12}`);
  }
  if (!auditedSchemas.has(schema)) {
    assertSupportedSchema(schema);
    auditedSchemas.add(schema);
  }
  const errors = [];
  validateNode(schema, value, '$', schema, errors);
  if (errors.length > 0) {
    throw new Error(`${label} fails pinned Draft 2020-12 JSON Schema: ${errors.slice(0, 8).join('; ')}`);
  }
  return value;
}
