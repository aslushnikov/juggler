"use strict";

const { SimpleChannel } = ChromeUtils.import('chrome://juggler/content/SimpleChannel.js');

class JugglerFrameChild extends JSWindowActorChild {
  constructor() {
    super();
  }

  handleEvent(event) { }

  async actorCreated() {
    this.channel = SimpleChannel.createForActor('content::frame', this);
  }

  receiveMessage() { }
}

var EXPORTED_SYMBOLS = ['JugglerFrameChild'];
