const api = require('../../utils/request.js');

Page({
  data: {
    code: '',
    preview: null,
    loading: true,
    accepting: false,
    error: '',
    result: null,
  },

  onLoad(options) {
    const code = (options && (options.code || options.invite)) || '';
    if (!code) {
      this.setData({ loading: false, error: '邀请链接缺少邀请码' });
      return;
    }
    this.setData({ code });
    this.loadPreview();
  },

  loadPreview() {
    this.setData({ loading: true, error: '' });
    api
      .get(`/api/invites/${this.data.code}`)
      .then((data) => {
        this.setData({ preview: data, loading: false });
        wx.setNavigationBarTitle({ title: `加入 ${data.organization.name}` });
      })
      .catch((err) => this.setData({ loading: false, error: err.message || '邀请码无效' }));
  },

  onAccept() {
    if (this.data.accepting) return;
    this.setData({ accepting: true });
    api
      .post(`/api/invites/${this.data.code}/accept`, {}, { auth: true })
      .then((data) => {
        this.setData({ accepting: false, result: data });
        wx.showToast({ title: '已加入' });
      })
      .catch((err) => {
        this.setData({ accepting: false });
        wx.showToast({ title: err.message || '加入失败', icon: 'none', duration: 2500 });
      });
  },

  onGoWorkbench() {
    wx.redirectTo({ url: `/pages/workbench/index?orgId=${this.data.result.organization.id}` });
  },
});
