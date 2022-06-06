"use strict";

const { SimpleChannel } = ChromeUtils.import('chrome://juggler/content/SimpleChannel.js');
const { BrowserFrameTree } = ChromeUtils.import('chrome://juggler/content/BrowserFrameTree.js');

var EXPORTED_SYMBOLS = ['JugglerFrameParent'];

class JugglerFrameParent extends JSWindowActorParent {
  constructor() {
    super();
  }

  receiveMessage() { }

  async actorCreated() {
    this.channel = SimpleChannel.createForActor('browser::frame', this);
    const frameTree = BrowserFrameTree.instance();
    this._frame = frameTree.browsingContextToFrame(this.browsingContext);
    if (!this._frame)
      return;
    dump(`
      pair created for frame: ${this._frame.id()}
    `);
  }

  didDestroy() {
    if (!this._frame)
      return;
    dump(`
      pair destroyed for frame: ${this._frame.id()}
    `);
  }
}
