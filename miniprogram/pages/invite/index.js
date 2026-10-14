const api = require('../../utils/request.js');
const { pages } = require('../../config.js');

Page({
  data: {
    orgId: '',
    orgName: '',
    roleOptions: [
      { value: 'admin', label: '管理员', desc: '可编辑机构资料、项目与报名表' },
      { value: 'operator', label: '运营', desc: '可查看报名记录、处理报名与查看二维码' },
    ],
    roleIndex: 1,
    creating: false,
    invite: null,
    error: '',
  },

  onLoad(options) {
    const orgId = (options && options.orgId) || '';
    if (!orgId) {
      this.setData({ error: '缺少机构标识' });
      return;
    }
    this.setData({ orgId });
    api.get(`/api/orgs/${orgId}`, { auth: true }).then((data) => {
      this.setData({ orgName: data.organization.name });
    });
    this.loadPending();
  },

  loadPending() {
    api
      .get(`/api/orgs/${this.data.orgId}/invites`, { auth: true })
      .then((data) => {
        const pending = (data.invites || []).filter((i) => i.status === 'pending');
        this.setData({ invite: pending[0] ? pending[0] : null });
      })
      .catch(() => {
        /* 列表拿不到不影响新建 */
      });
  },

  onRoleChange(e) {
    this.setData({ roleIndex: Number(e.detail.value) });
  },

  onCreate() {
    if (this.data.creating) return;
    this.setData({ creating: true });
    const role = this.data.roleOptions[this.data.roleIndex].value;
    api
      .post(`/api/orgs/${this.data.orgId}/invites`, { role }, { auth: true })
      .then((data) => {
        this.setData({ creating: false, invite: data.invite });
        wx.showToast({ title: '邀请码已生成' });
      })
      .catch((err) => {
        this.setData({ creating: false });
        wx.showToast({ title: err.message || '生成失败', icon: 'none' });
      });
  },

  onRevoke() {
    const invite = this.data.invite;
    if (!invite) return;
    wx.showModal({
      title: '撤销邀请',
      content: '撤销后该邀请码立即失效，已收到的人无法加入。',
      confirmText: '撤销',
      success: (res) => {
        if (!res.confirm) return;
        api
          .delete(`/api/orgs/${this.data.orgId}/invites/${invite.id}`, { auth: true })
          .then(() => {
            this.setData({ invite: null });
            wx.showToast({ title: '已撤销' });
          })
          .catch((err) => wx.showToast({ title: err.message || '操作失败', icon: 'none' }));
      },
    });
  },

  onCopyCode() {
    if (!this.data.invite) return;
    wx.setClipboardData({ data: this.data.invite.code });
  },

  onCopyPath() {
    if (!this.data.invite) return;
    wx.setClipboardData({
      data: `${pages.inviteAccept}?code=${this.data.invite.code}`,
    });
  },

  onShareAppMessage() {
    const invite = this.data.invite;
    return {
      title: `${this.data.orgName} 邀请你加入`,
      path: invite ? `${pages.inviteAccept}?code=${invite.code}` : `${pages.inviteAccept}`,
    };
  },
});
