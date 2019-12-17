"use strict";

const {ContextualIdentityService} = ChromeUtils.import("resource://gre/modules/ContextualIdentityService.jsm");
const {Services} = ChromeUtils.import("resource://gre/modules/Services.jsm");
const {NetUtil} = ChromeUtils.import('resource://gre/modules/NetUtil.jsm');

const IDENTITY_NAME = 'JUGGLER ';
const HUNDRED_YEARS = 60 * 60 * 24 * 365 * 100;

const ALL_PERMISSIONS = [
  'geo',
  'microphone',
  'camera',
  'desktop-notifications',
];

class BrowserContextManager {
  static instance() {
    return BrowserContextManager._instance || null;
  }

  static initialize() {
    if (BrowserContextManager._instance)
      return;
    BrowserContextManager._instance = new BrowserContextManager();
  }

  constructor() {
    this._id = 0;
    this._browserContextIdToUserContextId = new Map();
    this._userContextIdToBrowserContextId = new Map();
    this._principalsForBrowserContextId = new Map();

    // Cleanup containers from previous runs (if any)
    for (const identity of ContextualIdentityService.getPublicIdentities()) {
      if (identity.name && identity.name.startsWith(IDENTITY_NAME)) {
        ContextualIdentityService.remove(identity.userContextId);
        ContextualIdentityService.closeContainerTabs(identity.userContextId);
      }
    }
  }

  grantPermissions(browserContextId, origin, permissions) {
    const attrs = browserContextId ? {userContextId: this.userContextId(browserContextId)} : {};
    const principal = Services.scriptSecurityManager.createContentPrincipal(NetUtil.newURI(origin), attrs);
    if (!this._principalsForBrowserContextId.has(browserContextId))
      this._principalsForBrowserContextId.set(browserContextId, []);
    this._principalsForBrowserContextId.get(browserContextId).push(principal);
    for (const permission of ALL_PERMISSIONS) {
      const action = permissions.includes(permission) ? Ci.nsIPermissionManager.ALLOW_ACTION : Ci.nsIPermissionManager.DENY_ACTION;
      Services.perms.addFromPrincipal(principal, permission, action);
    }
  }

  resetPermissions(browserContextId) {
    if (!this._principalsForBrowserContextId.has(browserContextId))
      return;
    const principals = this._principalsForBrowserContextId.get(browserContextId);
    for (const principal of principals) {
      for (const permission of ALL_PERMISSIONS)
        Services.perms.removeFromPrincipal(principal, permission);
    }
    this._principalsForBrowserContextId.delete(browserContextId);
  }

  createBrowserContext() {
    const browserContextId = (++this._id) + '';
    const identity = ContextualIdentityService.create(IDENTITY_NAME + browserContextId);
    this._browserContextIdToUserContextId.set(browserContextId, identity.userContextId);
    this._userContextIdToBrowserContextId.set(identity.userContextId, browserContextId);
    return browserContextId;
  }

  browserContextId(userContextId) {
    return this._userContextIdToBrowserContextId.get(userContextId);
  }

  userContextId(browserContextId) {
    return this._browserContextIdToUserContextId.get(browserContextId);
  }

  removeBrowserContext(browserContextId) {
    const userContextId = this._browserContextIdToUserContextId.get(browserContextId);
    ContextualIdentityService.remove(userContextId);
    ContextualIdentityService.closeContainerTabs(userContextId);
    this._browserContextIdToUserContextId.delete(browserContextId);
    this._userContextIdToBrowserContextId.delete(userContextId);
  }

  getBrowserContexts() {
    return Array.from(this._browserContextIdToUserContextId.keys());
  }

  setCookies(browserContextId, cookies) {
    const protocolToSameSite = {
      [undefined]: Ci.nsICookie.SAMESITE_NONE,
      'Lax': Ci.nsICookie.SAMESITE_LAX,
      'Strict': Ci.nsICookie.SAMESITE_STRICT,
    };
    const userContextId = browserContextId ? this._browserContextIdToUserContextId.get(browserContextId) : undefined;
    for (const cookie of cookies) {
      const uri = cookie.url ? NetUtil.newURI(cookie.url) : null;
      let domain = cookie.domain;
      if (!domain) {
        if (!uri)
          throw new Error('At least one of the url and domain needs to be specified');
        domain = uri.host;
      }
      let path = cookie.path;
      if (!path)
        path = uri ? dirPath(uri.filePath) : '/';
      let secure = false;
      if (cookie.secure !== undefined)
        secure = cookie.secure;
      else if (uri && uri.scheme === 'https')
        secure = true;
      Services.cookies.add(
        domain,
        path,
        cookie.name,
        cookie.value,
        secure,
        cookie.httpOnly || false,
        cookie.expires === undefined || cookie.expires === -1 /* isSession */,
        cookie.expires === undefined ? Date.now() + HUNDRED_YEARS : cookie.expires,
        { userContextId } /* originAttributes */,
        protocolToSameSite[cookie.sameSite],
      );
    }
  }

  clearCookies(browserContextId) {
    const userContextId = browserContextId ? this._browserContextIdToUserContextId.get(browserContextId) : undefined;
    Services.cookies.removeCookiesWithOriginAttributes(JSON.stringify({ userContextId }));
  }

  getCookies(browserContextId) {
    const userContextId = browserContextId ? this._browserContextIdToUserContextId.get(browserContextId) : 0;
    const result = [];
    const sameSiteToProtocol = {
      [Ci.nsICookie.SAMESITE_NONE]: 'None',
      [Ci.nsICookie.SAMESITE_LAX]: 'Lax',
      [Ci.nsICookie.SAMESITE_STRICT]: 'Strict',
    };
    for (let cookie of Services.cookies.enumerator) {
      if (cookie.originAttributes.userContextId !== userContextId)
        continue;
      if (cookie.host === 'addons.mozilla.org')
        continue;
      result.push({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.host,
        path: cookie.path,
        expires: cookie.isSession ? -1 : cookie.expiry,
        size: cookie.name.length + cookie.value.length,
        httpOnly: cookie.isHttpOnly,
        secure: cookie.isSecure,
        session: cookie.isSession,
        sameSite: sameSiteToProtocol[cookie.sameSite],
      });
    }
    return result;
  }
}

function dirPath(path) {
  return path.substring(0, path.lastIndexOf('/') + 1);
}

var EXPORTED_SYMBOLS = ['BrowserContextManager'];
this.BrowserContextManager = BrowserContextManager;

