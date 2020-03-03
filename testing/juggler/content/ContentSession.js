const {Helper} = ChromeUtils.import('chrome://juggler/content/Helper.js');
const {RuntimeAgent} = ChromeUtils.import('chrome://juggler/content/content/RuntimeAgent.js');
const {PageAgent} = ChromeUtils.import('chrome://juggler/content/content/PageAgent.js');

const helper = new Helper();

class ContentSession {
  /**
   * @param {string} sessionId
   * @param {!ContentFrameMessageManager} messageManager
   * @param {!FrameTree} frameTree
   * @param {!NetworkMonitor} networkMonitor
   */
  constructor(sessionId, messageManager, frameTree, networkMonitor) {
    this._sessionId = sessionId;
    this._messageManager = messageManager;
    const runtimeAgent = new RuntimeAgent(this);
    const pageAgent = new PageAgent(this, runtimeAgent, frameTree, networkMonitor);
    this._agents = {
      Page: pageAgent,
      Runtime: runtimeAgent,
    };
    this._eventListeners = [
      helper.addMessageListener(messageManager, this._sessionId, this._onMessage.bind(this)),
    ];
    runtimeAgent.enable();
    pageAgent.enable();
  }

  emitEvent(eventName, params) {
    this._messageManager.sendAsyncMessage(this._sessionId, {eventName, params});
  }

  mm() {
    return this._messageManager;
  }

  async handleMessage({ id, methodName, params }) {
    try {
      const [domain, method] = methodName.split('.');
      const agent = this._agents[domain];
      if (!agent)
        throw new Error(`unknown domain: ${domain}`);
      const handler = agent[method];
      if (!handler)
        throw new Error(`unknown method: ${domain}.${method}`);
      const result = await handler.call(agent, params);
      return {id, result};
    } catch (e) {
      return {id, error: e.message + '\n' + e.stack};
    }
  }

  async _onMessage(msg) {
    const response = await this.handleMessage(msg.data);
    this._messageManager.sendAsyncMessage(this._sessionId, response);
  }

  dispose() {
    helper.removeListeners(this._eventListeners);
    for (const agent of Object.values(this._agents))
      agent.dispose();
  }
}

var EXPORTED_SYMBOLS = ['ContentSession'];
this.ContentSession = ContentSession;

