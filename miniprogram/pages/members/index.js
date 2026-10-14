const api = require('../../utils/request.js');

const ROLE_ACTIONS = {
  admin: [
    { value: 'operator', label: '降为运营' },
  ],
  operator: [
    { value: 'admin', label: '升为管理员' },
  ],
};

Page({
  data: {
    orgId: '',
    members: [],
    roleLabels: {},
    roleDescriptions: {},
    ownerCount: 0,
    myRole: '',
    canManage: false,
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
    api
      .get(`/api/orgs/${this.data.orgId}/members`, { auth: true })
      .then((data) => {
        const mine = (data.members || []).find((m) => m.isMe);
        this.setData({
          members: (data.members || []).map((m) => ({ ...m, roleText: m.roleLabel })),
          roleLabels: data.roleLabels || {},
          roleDescriptions: data.roleDescriptions || {},
          ownerCount: data.ownerCount,
          myRole: mine ? mine.role : '',
          canManage: mine ? mine.role === 'owner' : false,
          loading: false,
        });
      })
      .catch((err) => this.setData({ loading: false, error: err.message || '加载失败' }));
  },

  onInvite() {
    wx.navigateTo({ url: `/pages/invite/index?orgId=${this.data.orgId}` });
  },

  onChangeRole(e) {
    const { memberId, role } = e.currentTarget.dataset;
    const member = this.data.members.filter((m) => m.id === memberId)[0];
    if (!member) return;
    const action = (ROLE_ACTIONS[member.role] || []).filter((a) => a.value === role)[0];
    wx.showModal({
      title: action ? action.label : '调整角色',
      content: `将「${member.nickname || '该成员'}」调整为「${this.data.roleLabels[role]}」？`,
      confirmText: '确定',
      success: (res) => {
        if (!res.confirm) return;
        api
          .patch(`/api/orgs/${this.data.orgId}/members/${memberId}`, { role }, { auth: true })
          .then(() => {
            wx.showToast({ title: '已调整' });
            this.load();
          })
          .catch((err) => wx.showToast({ title: err.message || '操作失败', icon: 'none', duration: 2500 }));
      },
    });
  },

  onRemoveMember(e) {
    const { memberId, name } = e.currentTarget.dataset;
    wx.showModal({
      title: '移出机构',
      content: `确定将「${name || '该成员'}」移出本机构吗？该成员将立即失去访问权限。`,
      confirmText: '移出',
      confirmColor: '#d4380d',
      success: (res) => {
        if (!res.confirm) return;
        api
          .delete(`/api/orgs/${this.data.orgId}/members/${memberId}`, { auth: true })
          .then(() => {
            wx.showToast({ title: '已移出' });
            this.load();
          })
          .catch((err) => wx.showToast({ title: err.message || '操作失败', icon: 'none', duration: 2500 }));
      },
    });
  },

  onRetry() {
    this.load();
  },
});
