function pad(n) {
  return n < 10 ? '0' + n : '' + n;
}

function formatDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

const PROJECT_TYPES = [
  { value: 'course', label: '课程培训' },
  { value: 'camp', label: '训练营/夏令营' },
  { value: 'study_tour', label: '研学/旅行' },
  { value: 'competition', label: '比赛/活动' },
  { value: 'vocational', label: '职业培训' },
  { value: 'other', label: '其他' },
];

function projectTypeLabel(value) {
  const hit = PROJECT_TYPES.filter((t) => t.value === value)[0];
  return hit ? hit.label : '其他';
}

const FIELD_TYPE_LABELS = {
  text: '单行文本',
  textarea: '多行文本',
  phone: '手机号',
  number: '数字',
  radio: '单选',
  checkbox: '多选',
  select: '下拉',
  date: '日期',
};

function fieldTypeLabel(value) {
  return FIELD_TYPE_LABELS[value] || value;
}

const REGISTRATION_STATUS_LABELS = {
  pending: '待处理',
  contacted: '已联系',
  confirmed: '已确认',
  rejected: '已放弃',
};

function registrationStatusLabel(value) {
  return REGISTRATION_STATUS_LABELS[value] || value;
}

const SIGNUP_STATE_LABELS = {
  open: '报名中',
  not_started: '报名未开始',
  ended: '报名已截止',
  disabled: '报名已暂停',
  full: '名额已满',
  unlisted: '已下架',
  org_hidden: '机构未发布',
};

module.exports = {
  formatDateTime,
  formatDate,
  projectTypeLabel,
  fieldTypeLabel,
  registrationStatusLabel,
  PROJECT_TYPES,
  FIELD_TYPE_LABELS,
  REGISTRATION_STATUS_LABELS,
  SIGNUP_STATE_LABELS,
};
