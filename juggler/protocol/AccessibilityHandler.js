class AccessibilityHandler {
  constructor(chromeSession, sessionId, contentChannel) {
    this._chromeSession = chromeSession;
    this._contentPage = contentChannel.connect(sessionId + 'page');
  }

  async getFullAXTree(params) {
    return await this._contentPage.send('getFullAXTree', params);
  }

  dispose() {
    this._contentPage.dispose();
  }
}

var EXPORTED_SYMBOLS = ['AccessibilityHandler'];
this.AccessibilityHandler = AccessibilityHandler;
