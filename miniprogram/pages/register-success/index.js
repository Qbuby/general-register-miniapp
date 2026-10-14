const api = require('../../utils/request.js');

Page({
  data: {
    receipt: null,
    contact: null,
    error: '',
  },

  onLoad(options) {
    const receiptCode = (options && options.receipt) || '';
    if (!receiptCode) {
      this.setData({ error: '缺少报名编号' });
      return;
    }
    api
      .get(`/api/public/receipts/${receiptCode}`)
      .then((data) => {
        this.setData({ receipt: data.receipt, contact: data.contact });
      })
      .catch((err) => {
        this.setData({ error: err.message || '报名结果查询失败' });
      });
  },

  copyContact() {
    const c = this.data.contact;
    if (!c) return;
    wx.setClipboardData({ data: [c.name, c.phone, c.wechatId].filter(Boolean).join('\n') });
  },
});
