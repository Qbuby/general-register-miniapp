const api = require('../../utils/request.js');
const session = require('../../utils/session.js');

Page({
  data: {
    loading: true,
    error: '',
    user: null,
    organizations: [],
  },

  onShow() {
    this.load();
  },

  load() {
    this.setData({ loading: true, error: '' });
    return api
      .get('/api/me', { auth: true })
      .then((data) => {
        this.setData({ loading: false, user: data.user, organizations: data.organizations || [] });
      })
      .catch((err) => {
        this.setData({ loading: false, error: err.message || '加载失败' });
      });
  },

  onOpenOrg(e) {
    const { id } = e.currentTarget.dataset;
    wx.navigateTo({ url: `/pages/workbench/index?orgId=${id}` });
  },

  onCreateOrg() {
    wx.navigateTo({ url: '/pages/org-edit/index' });
  },

  onRetry() {
    this.load();
  },

  onSignOut() {
    wx.showModal({
      title: '退出登录',
      content: '退出后需要重新登录才能进入机构工作台。',
      success(res) {
        if (!res.confirm) return;
        session.clearToken();
        wx.reLaunch({ url: '/pages/mine/index' });
      },
    });
  },
});
