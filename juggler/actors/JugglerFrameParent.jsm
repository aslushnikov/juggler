"use strict";

const { SimpleChannel } = ChromeUtils.import('chrome://juggler/content/SimpleChannel.js');
const { BrowserFrame } = ChromeUtils.import('chrome://juggler/content/BrowserFrameTree.js');
const { Helper } = ChromeUtils.import('chrome://juggler/content/Helper.js');

const helper = new Helper();

var EXPORTED_SYMBOLS = ['JugglerFrameParent'];

class JugglerFrameParent extends JSWindowActorParent {
  constructor() {
    super();
  }

  receiveMessage() { }

  async actorCreated() {
    this._frame = BrowserFrame.fromBrowsingContext(this.browsingContext);;
    if (!this._frame)
      return;
    this._frame._setWindowActor(this);
  }

  didDestroy() {
    if (!this._frame)
      return;
    this._frame._setWindowActor(null);
  }
}
