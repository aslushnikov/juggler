class AccessibilityHandler {
  constructor(session, contentChannel) {
    this._contentPage = contentChannel.connect(session.sessionId() + 'page');
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
