/**
 * 前端表单校验。
 *
 * 这里只是为了让用户立刻看到错误、体验更顺；**服务端会用同一套规则重新校验**，
 * 前端校验不能替代后端校验。
 */
function isBlank(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

const CN_MOBILE = /^1[3-9]\d{9}$/;

function validateField(field, value) {
  if (isBlank(value)) {
    return field.required ? '请填写' + field.label : '';
  }
  switch (field.type) {
    case 'text':
    case 'textarea': {
      const str = String(value).trim();
      const max = field.maxLength == null ? (field.type === 'textarea' ? 2000 : 100) : field.maxLength;
      const min = field.minLength == null ? 0 : field.minLength;
      if (str.length < min) return field.label + '至少需要 ' + min + ' 个字符';
      if (str.length > max) return field.label + '不能超过 ' + max + ' 个字符';
      return '';
    }
    case 'phone': {
      const digits = String(value).trim().replace(/[\s()+-]/g, '').replace(/^0086/, '').replace(/^86(?=\d{11}$)/, '');
      if (!/^\d{6,20}$/.test(digits)) return '请输入正确的联系电话';
      if (digits.length === 11 && !CN_MOBILE.test(digits)) return '请输入正确的手机号码';
      return '';
    }
    case 'number': {
      const num = Number(String(value).trim());
      if (!isFinite(num)) return field.label + '必须是数字';
      if (field.minValue != null && num < field.minValue) return field.label + '不能小于 ' + field.minValue;
      if (field.maxValue != null && num > field.maxValue) return field.label + '不能大于 ' + field.maxValue;
      return '';
    }
    case 'radio':
    case 'select':
      return (field.options || []).indexOf(String(value).trim()) === -1 ? field.label + '的选项无效' : '';
    case 'checkbox': {
      const list = Array.isArray(value) ? value : [value];
      // 必须与服务端一致地先去重再计数，否则「选了 3 项但其中一项重复提交」
      // 会被误判成超限。
      const cleaned = [];
      list.forEach((item) => {
        const text = String(item).trim();
        if (cleaned.indexOf(text) === -1) cleaned.push(text);
      });
      const invalid = cleaned.filter((item) => (field.options || []).indexOf(item) === -1);
      if (invalid.length > 0) return field.label + '包含无效选项';
      const min = field.minLength == null ? 0 : field.minLength;
      const max = field.maxLength == null ? field.options.length : field.maxLength;
      if (cleaned.length < min) return field.label + '至少选择 ' + min + ' 项';
      if (cleaned.length > max) return field.label + '最多选择 ' + max + ' 项';
      return '';
    }
    case 'date': {
      const str = String(value).trim();
      // 除了格式，还要确认这个日期真实存在（2016-13-45 是格式对但不存在的日期）。
      const valid = /^\d{4}-\d{2}-\d{2}$/.test(str) && !isNaN(Date.parse(str + 'T00:00:00Z'));
      return valid ? '' : field.label + '请使用 YYYY-MM-DD 格式';
    }
    default:
      return '';
  }
}

function validateAll(fields, answers) {
  const errors = {};
  const known = {};
  fields.forEach((f) => {
    known[f.key] = true;
  });
  Object.keys(answers).forEach((key) => {
    if (!known[key]) errors[key] = '包含该报名表不存在的字段';
  });
  fields.forEach((field) => {
    const message = validateField(field, answers[field.key]);
    if (message) errors[field.key] = message;
  });
  return errors;
}

/** 过滤掉未填写的可选字段，让提交体保持干净。 */
function cleanAnswers(fields, answers) {
  const result = {};
  fields.forEach((field) => {
    const value = answers[field.key];
    if (!isBlank(value)) result[field.key] = value;
  });
  return result;
}

/** 生成幂等键：同一次填写重复点击提交时不会产生第二条记录。 */
function newIdempotencyKey() {
  return 'mp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

module.exports = { validateField, validateAll, cleanAnswers, newIdempotencyKey };
