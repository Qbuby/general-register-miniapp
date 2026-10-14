const api = require('../../utils/request.js');
const format = require('../../utils/format.js');

const STATUS_FILTERS = [
  { value: '', label: '全部' },
  { value: 'pending', label: '待处理' },
  { value: 'contacted', label: '已联系' },
  { value: 'confirmed', label: '已确认' },
  { value: 'rejected', label: '已放弃' },
];

Page({
  data: {
    orgId: '',
    projectId: '',
    projectTitle: '',
    rows: [],
    total: 0,
    page: 1,
    pageSize: 20,
    loading: true,
    loadingMore: false,
    error: '',
    query: '',
    statusFilter: '',
    statusFilters: STATUS_FILTERS,
    exportUrl: '',
  },

  onLoad(options) {
    const opts = options || {};
    this.setData({
      orgId: opts.orgId || '',
      projectId: opts.projectId || '',
      projectTitle: opts.title ? decodeURIComponent(opts.title) : '',
    });
    wx.setNavigationBarTitle({ title: this.data.projectTitle ? this.data.projectTitle + ' · 报名记录' : '报名记录' });
    this.load(1);
  },

  onReachBottom() {
    if (this.data.loadingMore || this.data.rows.length >= this.data.total) return;
    this.load(this.data.page + 1, true);
  },

  load(page, append) {
    const { orgId, projectId, query, statusFilter, pageSize } = this.data;
    if (append) this.setData({ loadingMore: true });
    else this.setData({ loading: true, error: '' });

    const params = [`page=${page}`, `pageSize=${pageSize}`];
    if (projectId) params.push(`projectId=${encodeURIComponent(projectId)}`);
    if (query) params.push(`q=${encodeURIComponent(query)}`);
    if (statusFilter) params.push(`status=${statusFilter}`);

    api
      .get(`/api/orgs/${orgId}/registrations?${params.join('&')}`, { auth: true })
      .then((data) => {
        const rows = (data.rows || []).map((r) => ({
          ...r,
          statusLabel: format.registrationStatusLabel(r.status),
          createdText: format.formatDateTime(r.createdAt),
          answerText: answerSummary(r.snapshot, r.answers),
        }));
        this.setData({
          rows: append ? this.data.rows.concat(rows) : rows,
          total: data.total,
          page,
          loading: false,
          loadingMore: false,
        });
        this.updateExportUrl();
      })
      .catch((err) => {
        this.setData({ loading: false, loadingMore: false, error: err.message || '加载失败' });
      });
  },

  updateExportUrl() {
    const { orgId, projectId, query, statusFilter } = this.data;
    const params = [];
    if (projectId) params.push(`projectId=${encodeURIComponent(projectId)}`);
    if (query) params.push(`q=${encodeURIComponent(query)}`);
    if (statusFilter) params.push(`status=${statusFilter}`);
    params.push(`token=${encodeURIComponent(require('../../utils/session.js').getToken())}`);
    this.setData({ exportUrl: `${api.baseUrl}/api/orgs/${orgId}/registrations/export.csv?${params.join('&')}` });
  },

  onSearchInput(e) {
    this.setData({ query: e.detail.value });
  },

  onSearch() {
    this.load(1);
  },

  onClearSearch() {
    this.setData({ query: '' });
    this.load(1);
  },

  onFilterStatus(e) {
    this.setData({ statusFilter: e.currentTarget.dataset.value });
    this.load(1);
  },

  onTapRow(e) {
    const index = Number(e.currentTarget.dataset.index);
    const row = this.data.rows[index];
    if (!row) return;
    const lines = [
      `报名编号：${row.receiptCode}`,
      `报名时间：${row.createdText}`,
      `状态：${row.statusLabel}`,
      '',
    ];
    (row.snapshot || []).forEach((field) => {
      const value = row.answers[field.key];
      const text = Array.isArray(value) ? value.join(' / ') : value === undefined || value === null ? '（未填写）' : value;
      lines.push(`${field.label}：${text}`);
    });
    wx.showModal({ title: '报名资料', content: lines.join('\n'), showCancel: false, confirmText: '关闭' });
  },

  onSetStatus(e) {
    const { index, status } = e.currentTarget.dataset;
    const row = this.data.rows[index];
    if (!row || row.status === status) return;
    api
      .patch(`/api/orgs/${this.data.orgId}/registrations/${row.id}`, { status }, { auth: true })
      .then(() => {
        wx.showToast({ title: '已更新' });
        this.load(1);
      })
      .catch((err) => wx.showToast({ title: err.message || '更新失败', icon: 'none' }));
  },

  onCopyPhone(e) {
    wx.setClipboardData({ data: e.currentTarget.dataset.phone });
  },

  /** 导出需要浏览器环境，用 downloadFile 取回后交给用户打开。 */
  onExport() {
    const { exportUrl } = this.data;
    wx.showLoading({ title: '正在准备导出…' });
    wx.downloadFile({
      url: exportUrl,
      filePath: wx.env.USER_DATA_PATH + '/registrations.csv',
      success(res) {
        wx.hideLoading();
        if (res.statusCode !== 200) {
          wx.showToast({ title: '导出失败（' + res.statusCode + '）', icon: 'none' });
          return;
        }
        wx.openDocument({
          filePath: res.tempFilePath,
          fileType: 'csv',
          showMenu: true,
          fail() {
            wx.showModal({
              title: '已下载',
              content: '当前环境无法直接预览 CSV，文件已保存到小程序本地目录。',
              showCancel: false,
            });
          },
        });
      },
      fail() {
        wx.hideLoading();
        wx.showToast({ title: '下载失败', icon: 'none' });
      },
    });
  },

  onRetry() {
    this.load(1);
  },
});

/** 列表里给机构看一眼摘要，详情在点开时用原始快照字段名展示。 */
function answerSummary(snapshot, answers) {
  const fields = snapshot || [];
  return fields
    .map((f) => {
      const value = answers[f.key];
      if (value === undefined || value === null || value === '') return '';
      return f.label + '：' + (Array.isArray(value) ? value.join('/') : value);
    })
    .filter(Boolean)
    .join('；');
}
