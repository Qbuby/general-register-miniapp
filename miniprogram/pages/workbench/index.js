const api = require('../../utils/request.js');
const format = require('../../utils/format.js');

Page({
  data: {
    orgId: '',
    organization: null,
    stats: null,
    projects: [],
    qr: null,
    loading: true,
    error: '',
  },

  onLoad(options) {
    this.setData({ orgId: (options && options.orgId) || '' });
    if (!this.data.orgId) {
      this.setData({ loading: false, error: '缺少机构标识' });
      return;
    }
    this.load();
  },

  onShow() {
    if (this.data.orgId) this.load();
  },

  load() {
    this.setData({ loading: true, error: '' });
    const orgId = this.data.orgId;
    return Promise.all([
      api.get(`/api/orgs/${orgId}`, { auth: true }),
      api.get(`/api/orgs/${orgId}/stats`, { auth: true }),
      api.get(`/api/orgs/${orgId}/projects`, { auth: true }),
    ])
      .then(([org, stats, projects]) => {
        this.setData({
          organization: org.organization,
          qr: org.qr,
          stats: stats.stats,
          projects: projects.projects.map((p) => ({
            ...p,
            typeLabel: format.projectTypeLabel(p.type),
            signupLabel: format.SIGNUP_STATE_LABELS[p.signup] || p.signup,
            startText: format.formatDateTime(p.start_at),
            signupEndText: format.formatDateTime(p.signup_end_at),
          })),
          loading: false,
        });
        wx.setNavigationBarTitle({ title: org.organization.name });
      })
      .catch((err) => {
        this.setData({ loading: false, error: err.message || '加载失败' });
      });
  },

  onCreateProject() {
    wx.navigateTo({ url: `/pages/project-edit/index?orgId=${this.data.orgId}` });
  },

  onEditProject(e) {
    const { id } = e.currentTarget.dataset;
    wx.navigateTo({ url: `/pages/project-edit/index?orgId=${this.data.orgId}&projectId=${id}` });
  },

  onEditOrg() {
    wx.navigateTo({ url: `/pages/org-edit/index?orgId=${this.data.orgId}` });
  },

  onViewRegistrations(e) {
    const { id, title } = e.currentTarget.dataset;
    const url = `/pages/registrations/index?orgId=${this.data.orgId}${id ? '&projectId=' + id : ''}${title ? '&title=' + encodeURIComponent(title) : ''}`;
    wx.navigateTo({ url });
  },

  onShowQr() {
    wx.navigateTo({ url: `/pages/qrcode/index?orgId=${this.data.orgId}` });
  },

  onManageMembers() {
    wx.navigateTo({ url: `/pages/members/index?orgId=${this.data.orgId}` });
  },

  onProjectQr(e) {
    const { id, title } = e.currentTarget.dataset;
    wx.navigateTo({ url: `/pages/qrcode/index?orgId=${this.data.orgId}&projectId=${id}&title=${encodeURIComponent(title || '')}` });
  },

  onRetry() {
    this.load();
  },
});
