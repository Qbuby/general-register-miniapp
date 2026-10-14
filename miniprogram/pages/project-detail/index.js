const api = require('../../utils/request.js');
const format = require('../../utils/format.js');
const formUtil = require('../../utils/form.js');
const { pages } = require('../../config.js');

Page({
  data: {
    code: '',
    organization: null,
    project: null,
    fields: [],
    answers: {},
    errors: {},
    loading: true,
    error: '',
    submitting: false,
    submittingText: '立即报名',
  },

  onLoad(options) {
    const code = (options && (options.scene || options.code || options.c)) || '';
    if (!code) {
      this.setData({ loading: false, error: '缺少项目标识，请扫描项目二维码进入' });
      return;
    }
    // 一次填写对应一个幂等键：用户狂点提交也不会产生多条报名记录。
    this.idempotencyKey = formUtil.newIdempotencyKey();
    this.setData({ code });
    this.load();
  },

  onShareAppMessage() {
    return {
      title: this.data.project ? this.data.project.title : '招生报名',
      path: `${pages.projectDetail}?code=${this.data.code}`,
    };
  },

  load() {
    this.setData({ loading: true, error: '' });
    return api
      .get(`/api/public/projects/${this.data.code}`)
      .then((data) => {
        const project = {
          ...data.project,
          typeLabel: format.projectTypeLabel(data.project.type),
          signupLabel: data.project.canSubmit ? '报名中' : data.project.signupReason || '暂未开放',
          startText: format.formatDateTime(data.project.startAt),
          endText: format.formatDateTime(data.project.endAt),
          signupEndText: format.formatDateTime(data.project.signupEndAt),
        };
        const answers = {};
        (data.fields || []).forEach((field) => {
          answers[field.key] = field.type === 'checkbox' ? [] : '';
        });
        this.setData({ project, organization: data.organization, fields: data.fields || [], answers, loading: false });
        wx.setNavigationBarTitle({ title: project.title });
      })
      .catch((err) => {
        this.setData({ loading: false, error: err.message || '项目加载失败' });
      });
  },

  onFieldChange(e) {
    const { key, value } = e.detail;
    const answers = { ...this.data.answers, [key]: value };
    const errors = { ...this.data.errors };
    delete errors[key];
    this.setData({ answers, errors });
  },

  onSubmit() {
    if (this.data.submitting) return;
    const errors = formUtil.validateAll(this.data.fields, this.data.answers);
    if (Object.keys(errors).length > 0) {
      this.setData({ errors });
      wx.showToast({ title: errors[Object.keys(errors)[0]] || '请检查填写内容', icon: 'none' });
      return;
    }

    this.setData({ submitting: true, submittingText: '提交中…' });
    api
      .post(
        `/api/public/projects/${this.data.code}/registrations`,
        { answers: formUtil.cleanAnswers(this.data.fields, this.data.answers), idempotencyKey: this.idempotencyKey },
        { auth: true }
      )
      .then((data) => {
        wx.redirectTo({
          url: `/pages/register-success/index?receipt=${data.receipt.receiptCode}&org=${encodeURIComponent(data.organization.name)}`,
        });
      })
      .catch((err) => {
        this.setData({ submitting: false, submittingText: '立即报名' });
        // 把服务端返回的逐字段错误回填到表单上。
        const details = err.details && err.details.errors;
        if (details) {
          this.setData({ errors: details });
        }
        wx.showToast({ title: err.message || '提交失败', icon: 'none', duration: 2500 });
      });
  },

  copyContact() {
    const org = this.data.organization;
    if (!org) return;
    wx.setClipboardData({
      data: [org.name, org.contactName, org.contactPhone, org.wechatId].filter(Boolean).join('\n'),
    });
  },

  onGoOrgHome() {
    wx.redirectTo({ url: `${pages.orgHome}?code=${this.data.code}` });
  },

  onRetry() {
    this.load();
  },
});
