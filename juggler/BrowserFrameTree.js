const {Helper} = ChromeUtils.import('chrome://juggler/content/Helper.js');

const helper = new Helper();

var EXPORTED_SYMBOLS = ['BrowserFrameTree'];
this.BrowserFrameTree = BrowserFrameTree;

class BrowserFrameTree {
  static instance() {
    return BrowserFrameTree._instance || null;
  }

  constructor() {
    BrowserFrameTree._instance = this;
    this._eventListeners = [
      helper.addObserver(this._onBrowsingContextAttached.bind(this), 'browsing-context-attached'),
      helper.addObserver(this._onBrowsingContextDiscarded.bind(this), 'browsing-context-discarded'),
    ];
  }

  _onBrowsingContextAttached(browsingContext) {
    dump(`
      browsing context attached: ${browsingContext.browserId}
    `);
  }

  _onBrowsingContextDiscarded(browsingContext, topic, why) {
    dump(`
      browsing context discarded: ${browsingContext.browserId} ${why}
    `);
  }
}

class BrowserFrame {
  constructor(browsingContext) {
  }
}
