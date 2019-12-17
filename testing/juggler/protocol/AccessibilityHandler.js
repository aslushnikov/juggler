class AccessibilityHandler {
  constructor(chromeSession, contentSession) {
    this._chromeSession = chromeSession;
    this._contentSession = contentSession;
  }

  async getFullAXTree() {
    return await this._contentSession.send('Page.getFullAXTree');
  }

  dispose() { }
}

var EXPORTED_SYMBOLS = ['AccessibilityHandler'];
this.AccessibilityHandler = AccessibilityHandler;
