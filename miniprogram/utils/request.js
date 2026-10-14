const { baseUrl } = require('../config.js');
const session = require('./session.js');

/**
 * 网络请求封装。
 *
 * - 需要登录的接口自动带上 token；
 * - 收到 401 会先静默登录再重试一次，用户不会看到登录页；
 * - 后端返回的业务错误统一抛出 { code, message, details }，页面据此给出具体提示。
 */
function request(options) {
  const { url, method = 'GET', data, auth = false, showError = true } = options;

  return new Promise((resolve, reject) => {
    const send = (token) => {
      const header = { 'content-type': 'application/json' };
      if (auth && token) header.authorization = 'Bearer ' + token;
      wx.request({
        url: baseUrl + url,
        method,
        data,
        header,
        success(res) {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(res.data);
            return;
          }
          if (res.statusCode === 401 && auth) {
            session.clearToken();
            session
              .ensureToken()
              .then((fresh) => {
                if (fresh !== token) send(fresh);
                else reject(buildError(res));
              })
              .catch(() => reject(buildError(res)));
            return;
          }
          reject(buildError(res));
        },
        fail(err) {
          reject({ code: 'network_error', message: '网络异常，请检查网络后重试', detail: err });
        },
      });
    };

    if (auth) {
      session
        .ensureToken()
        .then((token) => send(token))
        .catch((error) => {
          if (showError) wx.showToast({ title: error.message || '请先登录', icon: 'none' });
          reject(error);
        });
    } else {
      send('');
    }
  });
}

function buildError(res) {
  const payload = (res && res.data && res.data.error) || {};
  return {
    code: payload.code || 'http_' + (res && res.statusCode),
    message: payload.message || '请求失败（' + (res && res.statusCode) + '）',
    details: payload.details,
    statusCode: res && res.statusCode,
  };
}

const api = {
  get: (url, options) => request({ ...options, url, method: 'GET' }),
  post: (url, data, options) => request({ ...options, url, method: 'POST', data }),
  put: (url, data, options) => request({ ...options, url, method: 'PUT', data }),
  patch: (url, data, options) => request({ ...options, url, method: 'PATCH', data }),
  baseUrl,
};

module.exports = api;
