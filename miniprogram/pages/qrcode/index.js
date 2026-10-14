const api = require('../../utils/request.js');
const session = require('../../utils/session.js');

Page({
  data: {
    orgId: '',
    projectId: '',
    title: '',
    qr: null,
    imageUrl: '',
    downloading: false,
    loading: true,
    error: '',
    isProject: false,
  },

  onLoad(options) {
    const opts = options || {};
    const orgId = opts.orgId || '';
    const projectId = opts.projectId || '';
    if (!orgId) {
      this.setData({ loading: false, error: '缺少机构标识' });
      return;
    }
    this.setData({
      orgId,
      projectId,
      title: opts.title ? decodeURIComponent(opts.title) : '',
      isProject: Boolean(projectId),
    });
    wx.setNavigationBarTitle({ title: projectId ? '项目二维码' : '机构主页二维码' });
    this.load();
  },

  load() {
    const { orgId, projectId, isProject } = this.data;
    const url = isProject
      ? `/api/orgs/${orgId}/projects/${projectId}/qrcode`
      : `/api/orgs/${orgId}/qrcode`;

    api
      .get(url, { auth: true })
      .then((data) => {
        const token = session.getToken();
        const separator = data.imageUrl.indexOf('?') > -1 ? '&' : '?';
        this.setData({
          qr: data.qr,
          // 图片接口同样要做后端权限校验，所以带上 token。
          imageUrl: `${api.baseUrl}${data.imageUrl}${separator}token=${encodeURIComponent(token)}`,
          loading: false,
        });
      })
      .catch((err) => this.setData({ loading: false, error: err.message || '二维码加载失败' }));
  },

  onPreview() {
    wx.previewImage({ current: this.data.imageUrl, urls: [this.data.imageUrl] });
  },

  onSave() {
    if (this.data.downloading) return;
    this.setData({ downloading: true });
    wx.downloadFile({
      url: this.data.imageUrl,
      success: (res) => {
        this.setData({ downloading: false });
        if (res.statusCode !== 200) {
          wx.showToast({ title: '保存失败（' + res.statusCode + '）', icon: 'none' });
          return;
        }
        wx.saveImageToPhotosAlbum({
          filePath: res.tempFilePath,
          success: () => wx.showToast({ title: '已保存到相册' }),
          fail: () => wx.showToast({ title: '请在弹窗中允许保存到相册', icon: 'none' }),
        });
      },
      fail: () => {
        this.setData({ downloading: false });
        wx.showToast({ title: '下载失败', icon: 'none' });
      },
    });
  },

  onCopyTarget() {
    if (!this.data.qr) return;
    wx.setClipboardData({ data: this.data.qr.targetUrl });
  },

  onRetry() {
    this.setData({ loading: true, error: '' });
    this.load();
  },
});
