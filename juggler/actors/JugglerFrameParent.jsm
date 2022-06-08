"use strict";

const { SimpleChannel } = ChromeUtils.import('chrome://juggler/content/SimpleChannel.js');
const { TargetRegistry } = ChromeUtils.import('chrome://juggler/content/TargetRegistry.js');
const { Helper } = ChromeUtils.import('chrome://juggler/content/Helper.js');

const helper = new Helper();

var EXPORTED_SYMBOLS = ['JugglerFrameParent'];

class JugglerFrameParent extends JSWindowActorParent {
  constructor() {
    super();
  }

  receiveMessage() { }

  async actorCreated() {
    const pageTarget = TargetRegistry.instance().browserIdToPageTarget(this.browsingContext.browserId);

    if (!pageTarget)
      return;
    const frameTree = pageTarget.frameTree();
    this._frame = frameTree.browsingContextToFrame(this.browsingContext);
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
