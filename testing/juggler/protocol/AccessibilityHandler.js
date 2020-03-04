class AccessibilityHandler {
  constructor(chromeSession, sessionId, contentChannel) {
    this._chromeSession = chromeSession;
    this._contentSession = contentChannel.connect(sessionId + 'page');
  }

  async getFullAXTree(params) {
    return await this._contentSession.send('getFullAXTree', params);
  }

  dispose() { }
}

var EXPORTED_SYMBOLS = ['AccessibilityHandler'];
this.AccessibilityHandler = AccessibilityHandler;
