const api = require('../../utils/request.js');

const STATUS_OPTIONS = [
  { value: 'draft', label: '未发布' },
  { value: 'published', label: '已发布' },
  { value: 'hidden', label: '仅链接可见' },
];

Page({
  data: {
    orgId: '',
    isEdit: false,
    form: {
      name: '',
      logoUrl: '',
      coverUrl: '',
      intro: '',
      contactName: '',
      contactPhone: '',
      wechatId: '',
      address: '',
      status: 'draft',
    },
    statusOptions: STATUS_OPTIONS,
    statusIndex: 0,
    saving: false,
  },

  onLoad(options) {
    const orgId = (options && options.orgId) || '';
    if (!orgId) {
      this.setData({ isEdit: false });
      return;
    }
    this.setData({ orgId, isEdit: true });
    api
      .get(`/api/orgs/${orgId}`, { auth: true })
      .then((data) => {
        const org = data.organization;
        this.setData({
          form: {
            name: org.name || '',
            logoUrl: org.logoUrl || '',
            coverUrl: org.coverUrl || '',
            intro: org.intro || '',
            contactName: org.contactName || '',
            contactPhone: org.contactPhone || '',
            wechatId: org.wechatId || '',
            address: org.address || '',
            status: org.status || 'draft',
          },
          statusIndex: Math.max(0, STATUS_OPTIONS.map((s) => s.value).indexOf(org.status || 'draft')),
        });
      })
      .catch((err) => wx.showToast({ title: err.message, icon: 'none' }));
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`form.${field}`]: e.detail.value });
  },

  onStatusChange(e) {
    const index = Number(e.detail.value);
    this.setData({ statusIndex: index, 'form.status': STATUS_OPTIONS[index].value });
  },

  onSave() {
    if (this.data.saving) return;
    const form = this.data.form;
    if (!form.name || form.name.trim().length < 2) {
      wx.showToast({ title: '请填写机构名称', icon: 'none' });
      return;
    }
    const payload = {
      name: form.name.trim(),
      logoUrl: form.logoUrl.trim() || null,
      coverUrl: form.coverUrl.trim() || null,
      intro: form.intro,
      contactName: form.contactName.trim() || null,
      contactPhone: form.contactPhone.trim() || null,
      wechatId: form.wechatId.trim() || null,
      address: form.address.trim() || null,
      status: form.status,
    };

    this.setData({ saving: true });
    const request = this.data.isEdit
      ? api.patch(`/api/orgs/${this.data.orgId}`, payload, { auth: true })
      : api.post('/api/orgs', payload, { auth: true });

    request
      .then((data) => {
        this.setData({ saving: false });
        wx.showToast({ title: '保存成功' });
        setTimeout(() => {
          wx.redirectTo({ url: `/pages/workbench/index?orgId=${data.organization.id}` });
        }, 600);
      })
      .catch((err) => {
        this.setData({ saving: false });
        wx.showToast({ title: err.message || '保存失败', icon: 'none' });
      });
  },
});
