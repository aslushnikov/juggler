"use strict";

const { SimpleChannel } = ChromeUtils.import('chrome://juggler/content/SimpleChannel.js');
const { TargetRegistry } = ChromeUtils.import('chrome://juggler/content/TargetRegistry.js');

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

    // Navigation committed!
    this._frame._onGlobalWindowCleared();
    this.channel = SimpleChannel.createForActor('browser::frame', this);
    dump(`
      pair created for frame: ${this._frame.frameId()}
    `);
  }

  didDestroy() {
    if (!this._frame)
      return;
    dump(`
      pair destroyed for frame: ${this._frame.frameId()}
    `);
  }
}
