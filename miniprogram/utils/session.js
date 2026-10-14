const { baseUrl } = require('../config.js');

const TOKEN_KEY = 'session_token';
const USER_KEY = 'session_user';

let loginPromise = null;

/** 微信登录换服务端会话 token。AppSecret 只在服务端使用。 */
function wechatLogin() {
  return new Promise((resolve, reject) => {
    wx.login({
      success(res) {
        if (!res.code) {
          reject(new Error('wx.login 未返回 code'));
          return;
        }
        postJSON('/api/auth/wechat/login', { code: res.code })
          .then(resolve)
          .catch(reject);
      },
      fail: reject,
    });
  });
}

/**
 * 开发环境兜底：服务端未配置微信凭据时（/api/config 会告诉你），
 * 改用服务端开放的开发登录，方便在开发者工具里跑通全流程。
 */
function devLogin() {
  return postJSON('/api/auth/dev-login', { nickname: '机构管理员' });
}

function postJSON(url, data) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: baseUrl + url,
      method: 'POST',
      data,
      header: { 'content-type': 'application/json' },
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data);
        } else {
          reject(new Error((res.data && res.data.error && res.data.error.message) || '请求失败'));
        }
      },
      fail: reject,
    });
  });
}

let remoteConfig = null;

function loadRemoteConfig() {
  if (remoteConfig) return Promise.resolve(remoteConfig);
  return new Promise((resolve) => {
    wx.request({
      url: baseUrl + '/api/config',
      method: 'GET',
      success(res) {
        remoteConfig = res.data || {};
        resolve(remoteConfig);
      },
      fail() {
        remoteConfig = {};
        resolve(remoteConfig);
      },
    });
  });
}

function ensureToken() {
  const token = wx.getStorageSync(TOKEN_KEY);
  if (token) return Promise.resolve(token);
  if (loginPromise) return loginPromise;

  loginPromise = loadRemoteConfig()
    .then((cfg) => {
      if (cfg.wechat && cfg.wechat.configured) return wechatLogin();
      if (cfg.devLogin) return devLogin();
      throw new Error('服务端未配置微信登录，且未开启开发登录');
    })
    .then((data) => {
      wx.setStorageSync(TOKEN_KEY, data.token);
      wx.setStorageSync(USER_KEY, data.user || {});
      loginPromise = null;
      return data.token;
    })
    .catch((error) => {
      loginPromise = null;
      throw error;
    });

  return loginPromise;
}

function getToken() {
  return wx.getStorageSync(TOKEN_KEY) || '';
}

function getUser() {
  return wx.getStorageSync(USER_KEY) || null;
}

function clearToken() {
  wx.removeStorageSync(TOKEN_KEY);
  wx.removeStorageSync(USER_KEY);
}

function warmUp() {
  loadRemoteConfig().catch(() => {});
}

module.exports = { ensureToken, getToken, getUser, clearToken, warmUp, baseUrl };
