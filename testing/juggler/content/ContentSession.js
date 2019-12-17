const {Helper} = ChromeUtils.import('chrome://juggler/content/Helper.js');
const {RuntimeAgent} = ChromeUtils.import('chrome://juggler/content/content/RuntimeAgent.js');
const {PageAgent} = ChromeUtils.import('chrome://juggler/content/content/PageAgent.js');

const helper = new Helper();

class ContentSession {
  /**
   * @param {string} sessionId
   * @param {!ContentFrameMessageManager} messageManager
   * @param {!FrameTree} frameTree
   * @param {!ScrollbarManager} scrollbarManager
   * @param {!NetworkMonitor} networkMonitor
   */
  constructor(sessionId, messageManager, frameTree, scrollbarManager, networkMonitor) {
    this._sessionId = sessionId;
    this._messageManager = messageManager;
    const runtimeAgent = new RuntimeAgent(this);
    const pageAgent = new PageAgent(this, runtimeAgent, frameTree, scrollbarManager, networkMonitor);
    this._agents = {
      Page: pageAgent,
      Runtime: runtimeAgent,
    };
    this._eventListeners = [
      helper.addMessageListener(messageManager, this._sessionId, this._onMessage.bind(this)),
    ];
  }

  emitEvent(eventName, params) {
    this._messageManager.sendAsyncMessage(this._sessionId, {eventName, params});
  }

  mm() {
    return this._messageManager;
  }

  async _onMessage(msg) {
    const id = msg.data.id;
    try {
      const [domainName, methodName] = msg.data.methodName.split('.');
      const agent = this._agents[domainName];
      if (!agent)
        throw new Error(`unknown domain: ${domainName}`);
      const handler = agent[methodName];
      if (!handler)
        throw new Error(`unknown method: ${domainName}.${methodName}`);
      const result = await handler.call(agent, msg.data.params);
      this._messageManager.sendAsyncMessage(this._sessionId, {id, result});
    } catch (e) {
      this._messageManager.sendAsyncMessage(this._sessionId, {id, error: e.message + '\n' + e.stack});
    }
  }

  dispose() {
    helper.removeListeners(this._eventListeners);
    for (const agent of Object.values(this._agents))
      agent.dispose();
  }
}

var EXPORTED_SYMBOLS = ['ContentSession'];
this.ContentSession = ContentSession;

