const api = require('../../utils/request.js');
const format = require('../../utils/format.js');
const { pages } = require('../../config.js');

Page({
  data: {
    code: '',
    organization: null,
    projects: [],
    loading: true,
    error: '',
  },

  onLoad(options) {
    // 扫小程序码进入时参数叫 scene；普通分享路径用 code。
    const code = (options && (options.scene || options.code || options.c)) || '';
    if (!code) {
      this.setData({ loading: false, error: '缺少机构标识，请扫描机构二维码进入' });
      return;
    }
    this.setData({ code });
    this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  onShareAppMessage() {
    const org = this.data.organization;
    return {
      title: org ? org.name : '招生报名',
      path: `${pages.orgHome}?code=${this.data.code}`,
    };
  },

  load() {
    this.setData({ loading: true, error: '' });
    return api
      .get(`/api/public/organizations/${this.data.code}`)
      .then((data) => {
        const projects = data.projects.map((p) => ({
          ...p,
          typeLabel: format.projectTypeLabel(p.type),
          signupLabel: p.canSubmit ? '报名中' : p.signupReason || '暂未开放',
          startText: format.formatDateTime(p.startAt),
        }));
        this.setData({
          organization: data.organization,
          projects,
          loading: false,
        });
        if (data.organization && data.organization.name) {
          wx.setNavigationBarTitle({ title: data.organization.name });
        }
      })
      .catch((error) => {
        this.setData({ loading: false, error: error.message || '机构主页加载失败' });
      });
  },

  onTapProject(e) {
    const { code } = e.currentTarget.dataset;
    if (!code) {
      wx.showToast({ title: '该项目二维码尚未生成', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: `${pages.projectDetail}?code=${code}` });
  },

  copyContact() {
    const org = this.data.organization;
    if (!org) return;
    const text = [org.name, org.contactName, org.contactPhone, org.wechatId, org.address]
      .filter(Boolean)
      .join('\n');
    wx.setClipboardData({ data: text });
  },

  onGoMine() {
    wx.navigateTo({ url: '/pages/mine/index' });
  },
});
