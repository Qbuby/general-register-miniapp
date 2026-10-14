const api = require('../../utils/request.js');
const format = require('../../utils/format.js');

const STATUS_OPTIONS = [
  { value: 'draft', label: '草稿（不对外展示）' },
  { value: 'published', label: '已发布（对外展示）' },
  { value: 'unlisted', label: '已下架（隐藏但保留数据）' },
];

const FIELD_TYPES = ['text', 'textarea', 'phone', 'number', 'radio', 'checkbox', 'select', 'date'];

const CHOICE_TYPES = ['radio', 'checkbox', 'select'];

function emptyField() {
  return {
    key: '',
    label: '',
    type: 'text',
    typeIndex: 0,
    required: false,
    placeholder: '',
    hint: '',
    options: [],
    minLength: null,
    maxLength: null,
    minValue: null,
    maxValue: null,
    optionsText: '',
  };
}

/** picker 用下标选中当前类型，WXML 里不能写数组字面量，所以先算好。 */
function withTypeIndex(field) {
  const index = FIELD_TYPES.indexOf(field.type);
  return { ...field, typeIndex: index > -1 ? index : 0 };
}

Page({
  data: {
    orgId: '',
    projectId: '',
    isEdit: false,
    form: {
      title: '',
      type: 'course',
      coverUrl: '',
      summary: '',
      description: '',
      location: '',
      startAt: '',
      endAt: '',
      signupStartAt: '',
      signupEndAt: '',
      capacity: '',
      status: 'draft',
      signupEnabled: true,
      allowDuplicate: false,
      sortOrder: 0,
    },
    typeOptions: format.PROJECT_TYPES,
    typeIndex: 0,
    fieldTypeOptions: FIELD_TYPES,
    fieldTypeLabels: FIELD_TYPES.map((t) => format.fieldTypeLabel(t)),
    statusOptions: STATUS_OPTIONS,
    statusIndex: 0,
    fields: [],
    saving: false,
    savingForm: false,
    formError: '',
  },

  onLoad(options) {
    const orgId = (options && options.orgId) || '';
    const projectId = (options && options.projectId) || '';
    if (!orgId) {
      wx.showToast({ title: '缺少机构标识', icon: 'none' });
      return;
    }
    this.setData({ orgId, projectId, isEdit: Boolean(projectId) });
    wx.setNavigationBarTitle({ title: projectId ? '编辑项目' : '新建项目' });
    if (projectId) this.loadProject();
  },

  loadProject() {
    const { orgId, projectId } = this.data;
    api
      .get(`/api/orgs/${orgId}/projects/${projectId}`, { auth: true })
      .then((data) => {
        const p = data.project;
        this.setData({
          form: {
            title: p.title || '',
            type: p.type || 'course',
            coverUrl: p.cover_url || '',
            summary: p.summary || '',
            description: p.description || '',
            location: p.location || '',
            // pickers want YYYY-MM-DD
            startAt: p.start_at ? format.formatDate(p.start_at) : '',
            endAt: p.end_at ? format.formatDate(p.end_at) : '',
            signupStartAt: p.signup_start_at ? format.formatDate(p.signup_start_at) : '',
            signupEndAt: p.signup_end_at ? format.formatDate(p.signup_end_at) : '',
            capacity: p.capacity == null ? '' : String(p.capacity),
            status: p.status,
            signupEnabled: Boolean(p.signup_enabled),
            allowDuplicate: Boolean(p.allow_duplicate),
            sortOrder: p.sort_order || 0,
          },
          typeIndex: Math.max(0, format.PROJECT_TYPES.map((t) => t.value).indexOf(p.type)),
          statusIndex: Math.max(0, STATUS_OPTIONS.map((s) => s.value).indexOf(p.status)),
          fields: (data.fields || []).map((f) => withTypeIndex({ ...f, optionsText: (f.options || []).join('\n') })),
        });
      })
      .catch((err) => wx.showToast({ title: err.message, icon: 'none' }));
  },

  // ---------------------------------------------------------------- 基础字段
  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`form.${field}`]: e.detail.value });
  },
  onDateChange(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`form.${field}`]: e.detail.value });
  },
  onTypeChange(e) {
    const index = Number(e.detail.value);
    this.setData({ typeIndex: index, 'form.type': format.PROJECT_TYPES[index].value });
  },
  onStatusChange(e) {
    const index = Number(e.detail.value);
    this.setData({ statusIndex: index, 'form.status': STATUS_OPTIONS[index].value });
  },
  onToggleSignup(e) {
    this.setData({ 'form.signupEnabled': e.detail.value });
  },
  onToggleDuplicate(e) {
    this.setData({ 'form.allowDuplicate': e.detail.value });
  },

  // ------------------------------------------------------------ 报名表构建器
  onAddField() {
    this.setData({ fields: [...this.data.fields, emptyField()], formError: '' });
  },

  onFieldInput(e) {
    const index = Number(e.currentTarget.dataset.index);
    const field = e.currentTarget.dataset.field;
    const fields = [...this.data.fields];
    fields[index] = { ...fields[index], [field]: e.detail.value };
    this.setData({ fields });
  },

  onFieldTypeChange(e) {
    const index = Number(e.currentTarget.dataset.index);
    const typeIndex = Number(e.detail.value);
    const fields = [...this.data.fields];
    fields[index] = { ...fields[index], type: FIELD_TYPES[typeIndex], typeIndex };
    this.setData({ fields });
  },

  onFieldRequiredChange(e) {
    const index = Number(e.currentTarget.dataset.index);
    const fields = [...this.data.fields];
    fields[index] = { ...fields[index], required: e.detail.value };
    this.setData({ fields });
  },

  onMove(e) {
    const index = Number(e.currentTarget.dataset.index);
    const delta = Number(e.currentTarget.dataset.delta);
    const target = index + delta;
    if (target < 0 || target >= this.data.fields.length) return;
    const fields = [...this.data.fields];
    const moved = fields.splice(index, 1)[0];
    fields.splice(target, 0, moved);
    this.setData({ fields });
  },

  onDeleteField(e) {
    const index = Number(e.currentTarget.dataset.index);
    const fields = this.data.fields.slice();
    fields.splice(index, 1);
    this.setData({ fields });
  },

  /** 用一套常用字段快速起步，机构再按需删改。 */
  onApplyTemplate() {
    wx.showActionSheet({
      itemList: ['成人/自报名（姓名+手机号）', '家长为孩子报名（学员+监护人）', '员工/团体报名（姓名+手机+单位）'],
      success: (res) => {
        const templates = [
          [
            { key: 'name', label: '姓名', type: 'text', required: true, maxLength: 30 },
            { key: 'phone', label: '手机号', type: 'phone', required: true },
            { key: 'remark', label: '备注', type: 'textarea', required: false, maxLength: 500 },
          ],
          [
            { key: 'child_name', label: '学员姓名', type: 'text', required: true },
            { key: 'guardian_phone', label: '监护人手机号', type: 'phone', required: true },
            { key: 'age', label: '年龄', type: 'number', required: false, minValue: 3, maxValue: 80 },
          ],
          [
            { key: 'name', label: '姓名', type: 'text', required: true },
            { key: 'phone', label: '手机号', type: 'phone', required: true },
            { key: 'company', label: '单位名称', type: 'text', required: false },
          ],
        ];
        const chosen = templates[res.tapIndex] || templates[0];
        this.setData({
          fields: chosen.map((f) => withTypeIndex({ ...emptyField(), ...f, optionsText: '' })),
          formError: '',
        });
      },
    });
  },

  onPreviewForm() {
    const fields = this.data.fields.filter((f) => f.label);
    if (fields.length === 0) {
      wx.showToast({ title: '请先添加字段', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '报名表预览',
      content: fields
        .map((f, i) => `${i + 1}. [${format.fieldTypeLabel(f.type)}${f.required ? ' 必填' : ''}] ${f.label}`)
        .join('\n'),
      showCancel: false,
      confirmText: '知道了',
    });
  },

  serializeFields() {
    const errors = [];
    const seen = {};
    const fields = this.data.fields.map((f, i) => {
      if (!f.label || !f.label.trim()) errors.push(`第 ${i + 1} 个字段缺少名称`);
      const key = (f.key || '').trim();
      if (key && seen[key]) errors.push(`字段标识重复：${key}`);
      if (key) seen[key] = true;
      const payload = {
        // 只在已有 key 时才发送，新的字段让服务端生成稳定标识
        ...(key ? { key } : {}),
        label: (f.label || '').trim(),
        type: f.type,
        required: Boolean(f.required),
        placeholder: (f.placeholder || '').trim() || null,
        hint: (f.hint || '').trim() || null,
      };
      if (CHOICE_TYPES.indexOf(f.type) > -1) {
        payload.options = (f.optionsText || '')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean);
        if (payload.options.length === 0) errors.push(`「${f.label}」是选择类字段，需要填写选项`);
      }
      const toNumber = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
      payload.minLength = toNumber(f.minLength);
      payload.maxLength = toNumber(f.maxLength);
      payload.minValue = toNumber(f.minValue);
      payload.maxValue = toNumber(f.maxValue);
      return payload;
    });
    return { fields, errors };
  },

  // -------------------------------------------------------------------- 保存
  onSave() {
    if (this.data.saving) return;
    const f = this.data.form;
    if (!f.title || !f.title.trim()) {
      wx.showToast({ title: '请填写项目名称', icon: 'none' });
      return;
    }
    const capacity = f.capacity === '' ? null : Number(f.capacity);
    if (capacity !== null && (!Number.isFinite(capacity) || capacity <= 0)) {
      wx.showToast({ title: '人数上限需为正整数，或留空表示不限', icon: 'none' });
      return;
    }

    const { fields, errors } = this.serializeFields();
    if (errors.length > 0) {
      wx.showModal({ title: '报名表有问题', content: errors.slice(0, 5).join('\n'), showCancel: false });
      return;
    }

    const payload = {
      title: f.title.trim(),
      type: f.type,
      coverUrl: (f.coverUrl || '').trim() || null,
      summary: f.summary,
      description: f.description,
      location: (f.location || '').trim() || null,
      startAt: f.startAt || null,
      endAt: f.endAt || null,
      signupStartAt: f.signupStartAt || null,
      signupEndAt: f.signupEndAt || null,
      capacity,
      status: f.status,
      signupEnabled: Boolean(f.signupEnabled),
      allowDuplicate: Boolean(f.allowDuplicate),
      sortOrder: Number(f.sortOrder) || 0,
    };

    this.setData({ saving: true });
    const { orgId, projectId } = this.data;
    const request = projectId
      ? api.patch(`/api/orgs/${orgId}/projects/${projectId}`, payload, { auth: true })
      : api.post(`/api/orgs/${orgId}/projects`, payload, { auth: true });

    request
      .then((data) => {
        const id = projectId || data.project.id;
        return this.saveForm(orgId, id, fields).then(() => id);
      })
      .then((id) => {
        this.setData({ saving: false, projectId: id, isEdit: true });
        wx.showToast({ title: '保存成功' });
        setTimeout(() => wx.navigateBack(), 600);
      })
      .catch((err) => {
        this.setData({ saving: false });
        wx.showToast({ title: err.message || '保存失败', icon: 'none', duration: 2500 });
      });
  },

  saveForm(orgId, projectId, fields) {
    return api.put(`/api/orgs/${orgId}/projects/${projectId}/form`, { fields }, { auth: true });
  },

  onTogglePublished() {
    const next = this.data.form.status === 'published' ? 'unlisted' : 'published';
    const index = STATUS_OPTIONS.map((s) => s.value).indexOf(next);
    this.setData({ 'form.status': next, statusIndex: index });
  },
});
